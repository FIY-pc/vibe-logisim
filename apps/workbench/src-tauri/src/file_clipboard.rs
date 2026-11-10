//! WebKit's native Cut action only reaches editable content. Use file actions
//! while the explorer owns focus, and keep native editing everywhere else.
#[cfg(target_os = "macos")]
use tauri::{
    Emitter, Manager,
    menu::{Menu, MenuItem},
};

#[cfg(target_os = "macos")]
struct Menus {
    native: Menu<tauri::Wry>,
    files: Menu<tauri::Wry>,
}

pub fn setup(app: &tauri::App) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    {
        let native = Menu::default(app.handle())?;
        let files = Menu::default(app.handle())?;
        for item in files.items()? {
            let Some(edit) = item.as_submenu() else {
                continue;
            };
            if edit.text()? != "Edit" {
                continue;
            }
            for (index, item) in edit.items()?.iter().enumerate() {
                let Some(item) = item.as_predefined_menuitem() else {
                    continue;
                };
                let text = item.text()?;
                let (action, key) = match text.as_str() {
                    "Cut" => ("cut", "X"),
                    "Copy" => ("copy", "C"),
                    "Paste" => ("paste", "V"),
                    _ => continue,
                };
                let replacement = MenuItem::with_id(
                    app,
                    format!("file-{action}"),
                    text,
                    true,
                    Some(format!("Cmd+{key}")),
                )?;
                edit.remove(item)?;
                edit.insert(&replacement, index)?;
            }
        }
        app.set_menu(native.clone())?;
        app.manage(Menus { native, files });
    }
    let _ = app;
    Ok(())
}

#[tauri::command]
pub fn file_clipboard_focus(app: tauri::AppHandle, focused: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    if let Some(menus) = app.try_state::<Menus>() {
        app.set_menu(if focused {
            menus.files.clone()
        } else {
            menus.native.clone()
        })
        .map_err(|error| error.to_string())?;
    }
    let _ = (app, focused);
    Ok(())
}

pub fn menu_event(app: &tauri::AppHandle, event: tauri::menu::MenuEvent) {
    #[cfg(target_os = "macos")]
    if let Some(action @ ("cut" | "copy" | "paste")) = event.id().as_ref().strip_prefix("file-") {
        let _ = app.emit("file-clipboard", action);
    }
    let _ = (app, event);
}
