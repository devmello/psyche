//! Windows Credential Manager: generic credentials, this machine only
//! (`CRED_PERSIST_LOCAL_MACHINE`, never roaming), encrypted at rest by the OS for this user.
//!
//! A credential blob holds at most 2560 bytes, so larger values are split: the credential at
//! `target` holds a 4-byte header (`P`, `K`, version 1, part count) and the first part; parts
//! 2..n live at `target#2`…`target#n`.

use windows::Win32::Foundation::ERROR_NOT_FOUND;
use windows::Win32::Security::Credentials::{
    CRED_FLAGS, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC, CREDENTIALW, CredDeleteW, CredFree,
    CredReadW, CredWriteW,
};
use windows::core::{HSTRING, PWSTR};

const PART: usize = 2048;
const MAX_PARTS: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CredError {
    NotFound,
    TooLarge,
    Malformed,
    Os(u32),
}

impl CredError {
    fn from_win(e: &windows::core::Error) -> CredError {
        if e.code() == ERROR_NOT_FOUND.to_hresult() {
            CredError::NotFound
        } else {
            CredError::Os(e.code().0 as u32)
        }
    }
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn write_one(target: &str, blob: &[u8], comment: &str) -> Result<(), CredError> {
    let mut t = wide(target);
    let mut c = wide(comment);
    let mut user = wide("psyche-helper");
    let cred = CREDENTIALW {
        Flags: CRED_FLAGS(0),
        Type: CRED_TYPE_GENERIC,
        TargetName: PWSTR(t.as_mut_ptr()),
        Comment: PWSTR(c.as_mut_ptr()),
        CredentialBlobSize: blob.len() as u32,
        CredentialBlob: blob.as_ptr() as *mut u8,
        Persist: CRED_PERSIST_LOCAL_MACHINE,
        UserName: PWSTR(user.as_mut_ptr()),
        ..Default::default()
    };
    // SAFETY: every pointer refers to a live local for the call; CredWrite copies the data.
    unsafe { CredWriteW(&cred, 0) }.map_err(|e| CredError::from_win(&e))
}

fn read_one(target: &str) -> Result<Vec<u8>, CredError> {
    let mut out: *mut CREDENTIALW = std::ptr::null_mut();
    // SAFETY: CredRead allocates `out`, freed with CredFree after the copy.
    unsafe {
        CredReadW(&HSTRING::from(target), CRED_TYPE_GENERIC, None, &mut out)
            .map_err(|e| CredError::from_win(&e))?;
        let c = &*out;
        let v = if c.CredentialBlob.is_null() {
            Vec::new()
        } else {
            std::slice::from_raw_parts(c.CredentialBlob, c.CredentialBlobSize as usize).to_vec()
        };
        CredFree(out as *const _);
        Ok(v)
    }
}

fn delete_one(target: &str) -> Result<(), CredError> {
    // SAFETY: plain call with a NUL-terminated string.
    unsafe { CredDeleteW(&HSTRING::from(target), CRED_TYPE_GENERIC, None) }
        .map_err(|e| CredError::from_win(&e))
}

fn part_target(target: &str, i: usize) -> String {
    format!("{target}#{i}")
}

/// Splits `value` into credential blobs (pure; tested).
pub fn split(value: &[u8]) -> Result<Vec<Vec<u8>>, CredError> {
    let chunks: Vec<&[u8]> = if value.is_empty() {
        vec![&[][..]]
    } else {
        value.chunks(PART).collect()
    };
    if chunks.len() > MAX_PARTS {
        return Err(CredError::TooLarge);
    }
    let mut out = Vec::with_capacity(chunks.len());
    for (i, c) in chunks.iter().enumerate() {
        if i == 0 {
            let mut first = vec![b'P', b'K', 1, chunks.len() as u8];
            first.extend_from_slice(c);
            out.push(first);
        } else {
            out.push(c.to_vec());
        }
    }
    Ok(out)
}

/// Reads the part count from the first blob.
pub fn header(first: &[u8]) -> Result<usize, CredError> {
    if first.len() < 4 || first[0] != b'P' || first[1] != b'K' || first[2] != 1 || first[3] == 0 {
        return Err(CredError::Malformed);
    }
    Ok(first[3] as usize)
}

pub fn exists(target: &str) -> Result<bool, CredError> {
    match read_one(target) {
        Ok(_) => Ok(true),
        Err(CredError::NotFound) => Ok(false),
        Err(e) => Err(e),
    }
}

/// Writes (replacing) a value of any size up to 128 KiB.
pub fn write(target: &str, value: &[u8], comment: &str) -> Result<(), CredError> {
    let parts = split(value)?;
    let _ = delete(target);
    for (i, p) in parts.iter().enumerate().skip(1) {
        write_one(&part_target(target, i + 1), p, comment)?;
    }
    write_one(target, &parts[0], comment)
}

pub fn read(target: &str) -> Result<Vec<u8>, CredError> {
    let first = read_one(target)?;
    let count = header(&first)?;
    let mut out = first[4..].to_vec();
    for i in 2..=count {
        out.extend(read_one(&part_target(target, i)).map_err(|e| {
            if e == CredError::NotFound {
                CredError::Malformed
            } else {
                e
            }
        })?);
    }
    Ok(out)
}

/// Deletes a value and its parts. `NotFound` when there was none.
pub fn delete(target: &str) -> Result<(), CredError> {
    let count = header(&read_one(target)?).unwrap_or(1);
    for i in 2..=count {
        let _ = delete_one(&part_target(target, i));
    }
    delete_one(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_and_header() {
        let parts = split(&[7u8; 5000]).unwrap();
        assert_eq!(parts.len(), 3);
        assert_eq!(header(&parts[0]).unwrap(), 3);
        assert_eq!(parts[0].len(), 4 + 2048);
        assert_eq!(parts[2].len(), 5000 - 4096);
        assert_eq!(header(&split(b"").unwrap()[0]).unwrap(), 1);
        assert!(header(b"PK").is_err());
        assert!(split(&vec![0u8; PART * MAX_PARTS + 1]).is_err());
    }

    #[test]
    fn credential_round_trip() {
        let target = format!("Psyche/test/{}", std::process::id());
        let big: Vec<u8> = (0..6000u32).map(|i| (i % 251) as u8).collect();
        write(&target, &big, "Psyche Helper test").unwrap();
        assert!(exists(&target).unwrap());
        assert_eq!(read(&target).unwrap(), big);
        write(&target, b"small", "Psyche Helper test").unwrap();
        assert_eq!(read(&target).unwrap(), b"small");
        assert!(
            !exists(&part_target(&target, 2)).unwrap(),
            "stale parts are removed"
        );
        delete(&target).unwrap();
        assert_eq!(read(&target), Err(CredError::NotFound));
        assert_eq!(delete(&target), Err(CredError::NotFound));
    }
}
