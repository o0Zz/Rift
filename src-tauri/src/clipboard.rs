//! The OS clipboard for the files panel: files copied in Rift paste in File Explorer / Finder and back, a copied
//! image pastes as a PNG file.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Opened on first use, then kept: on Linux the copied files stay on the clipboard only while it lives.
static CLIPBOARD: Mutex<Option<arboard::Clipboard>> = Mutex::new(None);

fn with<T>(f: impl FnOnce(&mut arboard::Clipboard) -> T) -> Result<T, String> {
    let mut guard = CLIPBOARD.lock().unwrap_or_else(|e| e.into_inner());
    if guard.is_none() {
        *guard = Some(arboard::Clipboard::new().map_err(|e| e.to_string())?);
    }
    Ok(f(guard.as_mut().unwrap()))
}

/// Puts `paths` on the clipboard as files, as File Explorer's Copy does.
pub fn copy_files(paths: &[PathBuf]) -> Result<(), String> {
    with(|c| c.set().file_list(paths))?.map_err(|e| e.to_string())
}

/// What a paste would bring.
pub enum Content {
    Files(Vec<PathBuf>),
    /// RGBA pixels.
    Image {
        width: usize,
        height: usize,
        rgba: Vec<u8>,
    },
}

/// The clipboard's files, else its image; None when it holds neither.
pub fn read() -> Result<Option<Content>, String> {
    with(|c| {
        if let Ok(files) = c.get().file_list()
            && !files.is_empty()
        {
            return Some(Content::Files(files));
        }
        c.get_image().ok().map(|img| Content::Image {
            width: img.width,
            height: img.height,
            rgba: img.bytes.into_owned(),
        })
    })
}

/// Pastes `content` into `dir`; returns what was created.
pub fn paste_into(dir: &Path, content: Content) -> std::io::Result<Vec<PathBuf>> {
    match content {
        Content::Files(files) => crate::files::copy_into(dir, &files),
        Content::Image {
            width,
            height,
            rgba,
        } => Ok(vec![crate::files::save_png(dir, width, height, &rgba)?]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Uses the real clipboard (overwrites it), hence ignored: `cargo test clipboard -- --ignored`.
    #[test]
    #[ignore]
    fn copied_files_paste_as_copies() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("a.txt");
        std::fs::write(&src, "hi").unwrap();
        let dest = tmp.path().join("dest");
        std::fs::create_dir(&dest).unwrap();

        copy_files(std::slice::from_ref(&src)).unwrap();
        let content = read().unwrap().expect("files on the clipboard");
        let made = paste_into(&dest, content).unwrap();

        assert_eq!(made, vec![dest.join("a.txt")]);
        assert_eq!(std::fs::read_to_string(&made[0]).unwrap(), "hi");
    }

    #[test]
    #[ignore]
    fn a_copied_image_pastes_as_png() {
        let tmp = tempfile::tempdir().unwrap();
        with(|c| {
            c.set_image(arboard::ImageData {
                width: 2,
                height: 1,
                bytes: vec![255, 0, 0, 255, 0, 0, 255, 255].into(),
            })
        })
        .unwrap()
        .unwrap();
        let made = paste_into(tmp.path(), read().unwrap().expect("an image")).unwrap();

        let img = image::open(&made[0]).unwrap().to_rgba8();
        assert_eq!((img.width(), img.height()), (2, 1));
        assert_eq!(img.get_pixel(1, 0).0, [0, 0, 255, 255]);
    }
}
