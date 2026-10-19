# Measurements: apple (2026-10-19 01:30)

Host: 27.0.1 on Apple M5, 16 GB.
Backend: container CLI version 1.5.0 (build: release, commit: unspeci).

| metric | value |
|---|---|
| cold: backend start | median 249 ms (min 215, p90 265, n 3) |
| cold: backend start + first container + first command | median 910 ms (min 860, p90 1055, n 3) |
| warm: run -d + first exec (new container) | median 617 ms (min 560, p90 695, n 10) |
| warm: one-shot run --rm true | median 609 ms (min 553, p90 674, n 10) |
| stop (with --init) | median 55 ms (min 45, p90 72, n 5) |
| restart: start stopped container + first exec | median 481 ms (min 478, p90 548, n 5) |
| exec round trip (exec true) | median 53 ms (min 47, p90 61, n 20) |
| exec round trip via runner wrapper (timeout + bash -c) | median 58 ms (min 45, p90 63, n 20) |
| host -> workspace volume via `container cp` | failed (rc 0, size none) |
| host -> workspace volume via `exec -i` stdin stream | 367 MB/s (545 ms) |
| host -> workspace via read-only bind mount (cp inside) | 719 MB/s (278 ms) |
| workspace -> host via rw bind mount (cp inside) | 976 MB/s (205 ms) |
| owner on host of a file written by UID 1000 | devmello:staff |
| within workspace volume (cp inside, baseline) | 1290 MB/s (155 ms) |
| memory (footprint): per-container VM, idle | 242 MB |
| memory (footprint): while the container holds 400 MB | 641 MB |
| memory (footprint): 20 s after the 400 MB was freed | 641 MB |
| memory (footprint): host services, shared by all containers | 25 MB |
