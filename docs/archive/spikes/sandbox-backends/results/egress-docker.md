# Egress proxy check: docker (2026-10-19 02:00)

Allowlist: --allow pypi.org --allow files.pythonhosted.org --allow registry.npmjs.org --allow github.com --allow *.nip.io

| check | result | detail |
|---|---|---|
| setup | INFO | proxy at 192.168.97.2 (HTTP 3128, SOCKS5 1080) |
| allowlisted https via HTTP proxy (pypi.org) | PASS | 200 |
| allowlisted https via SOCKS5 (socks5h) | PASS | 200 |
| non-allowlisted host denied (example.com) | PASS | curl: (56) CONNECT tunnel failed, response 403 000 |
| non-allowlisted host denied over SOCKS5 | PASS | curl: (97) cannot complete SOCKS5 connection to example.com. (2) 000 |
| plain http to non-allowlisted host denied | PASS | 403 |
| metadata IP via proxy denied (169.254.169.254) | PASS | 403 |
| allowlisted name resolving to loopback denied (127.0.0.1.nip.io) | PASS | curl: (56) CONNECT tunnel failed, response 403 000 |
| non-allowed port denied (pypi.org:22) | PASS | curl: (56) CONNECT tunnel failed, response 403 000 |
| direct https without proxy fails | PASS | curl: (6) Could not resolve host: pypi.org 000 |
| direct IP without proxy fails (1.1.1.1) | PASS | curl: (7) Failed to connect to 1.1.1.1 port 80 after 0 ms: Could not connect to server 000 |
| sandbox DNS for external names | PASS | getent failed (exit 2) |
| npm through the proxy (registry.npmjs.org) | PASS | left-pad 1.3.0 |
| git over https through the proxy (github.com) | PASS | 7fd1a60b01f91b314f59955a4e4d4e80d8edf11d	HEAD |
| other host services on 0.0.0.0 reachable? | PASS | http://0.250.250.254:18081/ -> curl: (7) Failed to connect to 0.250.250.254 port 18081 after 2 ms: Could not connect to server 000 |
| proxy log | INFO | 5 allowed, 6 denied (127.0.0.1.nip.io: resolves to non-public address 127.0.0.1;169.254.169.254: host not in allowlist;example.com: host not in allowlist;pypi.org: port 22 not allowed;) |

Failures: 0
