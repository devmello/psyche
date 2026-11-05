//! Registry reads (privacy consent store, toast settings) and the HKCU writes the toast COM
//! activator needs. Never touches HKLM for writing.

use windows::Win32::Foundation::ERROR_SUCCESS;
use windows::Win32::System::Registry::{
    HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, REG_SZ, RRF_RT_REG_DWORD, RRF_RT_REG_SZ,
    RegGetValueW, RegSetKeyValueW,
};
use windows::core::HSTRING;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Hive {
    CurrentUser,
    LocalMachine,
}

fn hkey(h: Hive) -> HKEY {
    match h {
        Hive::CurrentUser => HKEY_CURRENT_USER,
        Hive::LocalMachine => HKEY_LOCAL_MACHINE,
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
}
