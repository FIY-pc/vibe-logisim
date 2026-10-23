//! Append-only record files. Every record carries a checksum, so a write cut
//! short by a crash is recognised and dropped when the file is next opened.
//! Appends return before the data reaches the disk; a background thread
//! syncs it, so a request never waits for the disk.
//!
//! A record is `VLJ1`, the header and data lengths and a CRC-32 of both
//! (each a little-endian `u32`), then the header (JSON) and the data.
use crate::Result;
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    path::Path,
    sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock},
};

const MAGIC: [u8; 4] = *b"VLJ1";
const FIXED: usize = 16;

pub(crate) fn record(header: &[u8], data: &[u8]) -> Vec<u8> {
    let mut crc = crc32fast::Hasher::new();
    crc.update(header);
    crc.update(data);
    let mut out = Vec::with_capacity(FIXED + header.len() + data.len());
    out.extend_from_slice(&MAGIC);
    out.extend((header.len() as u32).to_le_bytes());
    out.extend((data.len() as u32).to_le_bytes());
    out.extend(crc.finalize().to_le_bytes());
    out.extend_from_slice(header);
    out.extend_from_slice(data);
    out
}

/// One intact record of a file.
pub(crate) struct Found<'a> {
    pub header: &'a [u8],
    pub data: &'a [u8],
    /// Where the data starts in the file.
    pub offset: u64,
}

/// The intact records at the start of `bytes`, and where they end.
pub(crate) fn scan(bytes: &[u8]) -> (Vec<Found<'_>>, usize) {
    let mut found = Vec::new();
    let mut at = 0;
    while let Some(fixed) = bytes.get(at..at + FIXED) {
        if fixed[..4] != MAGIC {
            break;
        }
        let word = |k: usize| u32::from_le_bytes(fixed[k..k + 4].try_into().expect("four bytes"));
        let (header, data) = (word(4) as usize, word(8) as usize);
        let start = at + FIXED;
        let Some(body) = bytes.get(start..start + header + data) else {
            break;
        };
        if crc32fast::hash(body) != word(12) {
            break;
        }
        found.push(Found {
            header: &body[..header],
            data: &body[header..],
            offset: (start + header) as u64,
        });
        at = start + header + data;
    }
    (found, at)
}

/// A record file open for appending.
pub(crate) struct Log {
    file: Arc<File>,
    len: u64,
}

impl Log {
    /// Writes a new file holding `records` and syncs it before returning, so
    /// whatever points at the file afterwards can rely on it.
    pub(crate) fn create(path: &Path, records: &[u8]) -> Result<Self> {
        let mut file = File::options()
            .read(true)
            .write(true)
            .create(true)
            .truncate(true)
            .open(path)?;
        file.write_all(records)?;
        file.sync_all()?;
        Ok(Self {
            file: Arc::new(file),
            len: records.len() as u64,
        })
    }

    /// Opens a file and returns its intact records' bytes; a torn tail is
    /// cut off.
    pub(crate) fn open(path: &Path) -> Result<(Self, Vec<u8>)> {
        let mut file = File::options().read(true).write(true).open(path)?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)?;
        let (_, valid) = scan(&bytes);
        if valid < bytes.len() {
            file.set_len(valid as u64)?;
            bytes.truncate(valid);
        }
        Ok((
            Self {
                file: Arc::new(file),
                len: valid as u64,
            },
            bytes,
        ))
    }

    pub(crate) fn len(&self) -> u64 {
        self.len
    }

    pub(crate) fn append(&mut self, records: &[u8]) -> Result<()> {
        let mut file = &*self.file;
        let written = file
            .seek(SeekFrom::Start(self.len))
            .and_then(|_| file.write_all(records));
        if let Err(error) = written {
            // Leave no partial record for the next append to follow.
            let _ = self.file.set_len(self.len);
            return Err(error.into());
        }
        self.len += records.len() as u64;
        sync_later(&self.file);
        Ok(())
    }

    pub(crate) fn read_at(&self, offset: u64, len: usize) -> Result<Vec<u8>> {
        let mut bytes = vec![0; len];
        #[cfg(unix)]
        std::os::unix::fs::FileExt::read_exact_at(&*self.file, &mut bytes, offset)?;
        #[cfg(windows)]
        {
            let mut done = 0;
            while done < len {
                let read = std::os::windows::fs::FileExt::seek_read(
                    &*self.file,
                    &mut bytes[done..],
                    offset + done as u64,
                )?;
                if read == 0 {
                    return Err(std::io::Error::from(std::io::ErrorKind::UnexpectedEof).into());
                }
                done += read;
            }
        }
        Ok(bytes)
    }
}

#[derive(Default)]
struct Queue {
    files: Vec<Arc<File>>,
    busy: bool,
}

struct Syncer {
    queue: Mutex<Queue>,
    changed: Condvar,
}

impl Syncer {
    fn get() -> &'static Syncer {
        static SYNCER: OnceLock<&'static Syncer> = OnceLock::new();
        SYNCER.get_or_init(|| {
            let syncer: &'static Syncer = Box::leak(Box::new(Syncer {
                queue: Mutex::default(),
                changed: Condvar::new(),
            }));
            std::thread::Builder::new()
                .name("journal-sync".into())
                .spawn(move || syncer.run())
                .expect("start the journal sync thread");
            syncer
        })
    }

    fn lock(&self) -> MutexGuard<'_, Queue> {
        self.queue.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn run(&self) {
        let mut queue = self.lock();
        loop {
            if queue.files.is_empty() {
                queue.busy = false;
                self.changed.notify_all();
                queue = self.changed.wait(queue).unwrap_or_else(|e| e.into_inner());
                continue;
            }
            // Appends made while a sync runs share the next one.
            let files = std::mem::take(&mut queue.files);
            queue.busy = true;
            drop(queue);
            for file in files {
                let _ = file.sync_data();
            }
            queue = self.lock();
        }
    }
}

fn sync_later(file: &Arc<File>) {
    let syncer = Syncer::get();
    let mut queue = syncer.lock();
    if !queue.files.iter().any(|queued| Arc::ptr_eq(queued, file)) {
        queue.files.push(file.clone());
    }
    syncer.changed.notify_all();
}

/// Waits until everything appended so far is on disk.
pub fn flush() {
    let syncer = Syncer::get();
    let mut queue = syncer.lock();
    while !queue.files.is_empty() || queue.busy {
        queue = syncer
            .changed
            .wait(queue)
            .unwrap_or_else(|e| e.into_inner());
    }
}
