//! Registry reads (privacy consent store, toast settings) and the HKCU writes the toast COM
//! activator needs. Never touches HKLM for writing.

use windows::Win32::Foundation::ERROR_SUCCESS;
use windows::Win32::System::Registry::{
    HKEY, HKEY_CLASSES_ROOT, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, REG_SZ,
    RRF_RT_REG_DWORD, RRF_RT_REG_SZ, RegCloseKey, RegEnumKeyExW, RegGetValueW, RegOpenKeyExW,
    RegSetKeyValueW,
};
use windows::core::HSTRING;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Hive {
    CurrentUser,
    LocalMachine,
    /// The merged HKLM / HKCU `Software\Classes` view (COM registrations; read-only here).
    ClassesRoot,
}

fn hkey(h: Hive) -> HKEY {
    match h {
        Hive::CurrentUser => HKEY_CURRENT_USER,
        Hive::LocalMachine => HKEY_LOCAL_MACHINE,
        Hive::ClassesRoot => HKEY_CLASSES_ROOT,
    }
}

/// A `REG_SZ` value (`name` empty for the default value).
pub fn read_string(hive: Hive, subkey: &str, name: &str) -> Option<String> {
    let sk = HSTRING::from(subkey);
    let nm = HSTRING::from(name);
    let mut size = 0u32;
    // SAFETY: size query, then a buffer of that size.
    unsafe {
        if RegGetValueW(
            hkey(hive),
            &sk,
            &nm,
            RRF_RT_REG_SZ,
            None,
            None,
            Some(&mut size),
        ) != ERROR_SUCCESS
            || size == 0
        {
            return None;
        }
        let mut buf = vec![0u16; (size as usize).div_ceil(2)];
        if RegGetValueW(
            hkey(hive),
            &sk,
            &nm,
            RRF_RT_REG_SZ,
            None,
            Some(buf.as_mut_ptr() as *mut _),
            Some(&mut size),
        ) != ERROR_SUCCESS
        {
            return None;
        }
        let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        Some(String::from_utf16_lossy(&buf[..len]))
    }
}

pub fn read_dword(hive: Hive, subkey: &str, name: &str) -> Option<u32> {
    let sk = HSTRING::from(subkey);
    let nm = HSTRING::from(name);
    let mut value = 0u32;
    let mut size = 4u32;
    // SAFETY: a 4-byte buffer for a DWORD.
    let r = unsafe {
        RegGetValueW(
            hkey(hive),
            &sk,
            &nm,
            RRF_RT_REG_DWORD,
            None,
            Some(&mut value as *mut u32 as *mut _),
            Some(&mut size),
        )
    };
    (r == ERROR_SUCCESS).then_some(value)
}

/// Whether `subkey` exists (and can be opened for reading).
pub fn key_exists(hive: Hive, subkey: &str) -> bool {
    let sk = HSTRING::from(subkey);
    let mut key = HKEY::default();
    // SAFETY: the opened key is closed before returning.
    unsafe {
        if RegOpenKeyExW(hkey(hive), &sk, None, KEY_READ, &mut key) != ERROR_SUCCESS {
            return false;
        }
        let _ = RegCloseKey(key);
    }
    true
}

/// Names of the direct subkeys of `subkey` (empty when it does not exist), at most `max`.
pub fn subkey_names(hive: Hive, subkey: &str, max: usize) -> Vec<String> {
    let sk = HSTRING::from(subkey);
    let mut key = HKEY::default();
    let mut out = Vec::new();
    // SAFETY: enumeration into a fixed buffer (registry key names are at most 255 chars); the
    // key is closed before returning.
    unsafe {
        if RegOpenKeyExW(hkey(hive), &sk, None, KEY_READ, &mut key) != ERROR_SUCCESS {
            return out;
        }
        let mut i = 0u32;
        while out.len() < max {
            let mut buf = [0u16; 256];
            let mut len = buf.len() as u32;
            let r = RegEnumKeyExW(
                key,
                i,
                Some(windows::core::PWSTR(buf.as_mut_ptr())),
                &mut len,
                None,
                None,
                None,
                None,
            );
            if r != ERROR_SUCCESS {
                break;
            }
            out.push(String::from_utf16_lossy(&buf[..len as usize]));
            i += 1;
        }
        let _ = RegCloseKey(key);
    }
    out
}

/// Writes a `REG_SZ` under HKCU, creating the key.
pub fn write_user_string(subkey: &str, name: &str, value: &str) -> windows::core::Result<()> {
    let sk = HSTRING::from(subkey);
    let nm = HSTRING::from(name);
    let data: Vec<u16> = value.encode_utf16().chain(std::iter::once(0)).collect();
    // SAFETY: the data buffer is a NUL-terminated UTF-16 string of the given byte length.
    unsafe {
        RegSetKeyValueW(
            HKEY_CURRENT_USER,
            &sk,
            &nm,
            REG_SZ.0,
            Some(data.as_ptr() as *const _),
            (data.len() * 2) as u32,
        )
        .ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_value_every_machine_has() {
        let v = read_string(
            Hive::LocalMachine,
            r"SOFTWARE\Microsoft\Windows NT\CurrentVersion",
            "CurrentBuild",
        );
        assert!(v.is_some_and(|s| s.chars().all(|c| c.is_ascii_digit())));
        assert!(read_string(Hive::CurrentUser, r"Software\Psyche\DoesNotExist", "x").is_none());
    }

    #[test]
    fn keys_and_subkeys() {
        assert!(key_exists(
            Hive::LocalMachine,
            r"SOFTWARE\Microsoft\Windows NT\CurrentVersion"
        ));
        assert!(!key_exists(
            Hive::CurrentUser,
            r"Software\Psyche\DoesNotExist"
        ));
        assert!(key_exists(Hive::ClassesRoot, "CLSID"));
        let names = subkey_names(Hive::LocalMachine, r"SOFTWARE\Microsoft", 500);
        assert!(names.iter().any(|n| n.eq_ignore_ascii_case("Windows")));
        assert!(subkey_names(Hive::CurrentUser, r"Software\Psyche\DoesNotExist", 5).is_empty());
    }
}
