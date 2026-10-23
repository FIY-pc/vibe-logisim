use crate::Result;

#[cfg(not(windows))]
pub(super) fn send(path: &std::path::Path) -> Result<()> {
    trash::delete(path).map_err(|error| error.to_string().into())
}

#[cfg(windows)]
pub(super) fn send(path: &std::path::Path) -> Result<()> {
    // A dedicated STA prevents inheriting a different COM apartment from Tokio's pool.
    let path = path.to_owned();
    std::thread::spawn(move || windows_recycle(&path))
        .join()
        .map_err(|_| "Windows 回收站操作中断".to_owned())?
}

#[cfg(windows)]
fn windows_recycle(path: &std::path::Path) -> Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows::{
        Win32::{
            System::Com::{
                CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx,
                CoUninitialize,
            },
            UI::Shell::{
                FOF_NO_UI, FOFX_ADDUNDORECORD, FOFX_EARLYFAILURE, FOFX_RECYCLEONDELETE,
                FileOperation, IFileOperation, IShellItem, SHCreateItemFromParsingName,
            },
        },
        core::PCWSTR,
    };
    struct Apartment;
    impl Drop for Apartment {
        fn drop(&mut self) {
            unsafe { CoUninitialize() }
        }
    }
    // Shell parsing rejects the verbatim prefix returned by Path::canonicalize.
    let encoded: Vec<u16> = path.as_os_str().encode_wide().collect();
    let prefix: Vec<u16> = r"\\?\".encode_utf16().collect();
    let unc: Vec<u16> = r"\\?\UNC\".encode_utf16().collect();
    let mut name = if encoded.starts_with(&unc) {
        r"\\"
            .encode_utf16()
            .chain(encoded[unc.len()..].iter().copied())
            .collect::<Vec<_>>()
    } else if encoded.starts_with(&prefix) {
        encoded[prefix.len()..].to_vec()
    } else {
        encoded
    };
    name.push(0);
    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED)
            .ok()
            .map_err(|error| error.to_string())?;
        let _apartment = Apartment;
        let operation: IFileOperation =
            CoCreateInstance(&FileOperation, None, CLSCTX_INPROC_SERVER)
                .map_err(|error| error.to_string())?;
        // ALLOWUNDO alone permits permanent deletion when recycling is unavailable.
        operation
            .SetOperationFlags(
                FOF_NO_UI | FOFX_RECYCLEONDELETE | FOFX_ADDUNDORECORD | FOFX_EARLYFAILURE,
            )
            .map_err(|error| error.to_string())?;
        let item: IShellItem = SHCreateItemFromParsingName(PCWSTR(name.as_ptr()), None)
            .map_err(|error| error.to_string())?;
        operation
            .DeleteItem(&item, None)
            .map_err(|error| error.to_string())?;
        operation
            .PerformOperations()
            .map_err(|error| error.to_string())?;
        if operation
            .GetAnyOperationsAborted()
            .map_err(|error| error.to_string())?
            .as_bool()
        {
            return Err("Windows 无法将文件移入回收站".into());
        }
    }
    Ok(())
}
