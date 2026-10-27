# Egress proxy check: apple (2026-10-19 01:58)

Allowlist: --allow pypi.org --allow files.pythonhosted.org --allow registry.npmjs.org --allow github.com --allow *.nip.io

| check | result | detail |
|---|---|---|
| setup | INFO | proxy at 192.168.128.1 (HTTP 3128, SOCKS5 1080) |
| allowlisted https via HTTP proxy (pypi.org) | PASS | 200 |
| allowlisted https via SOCKS5 (socks5h) | PASS | 200 |
| non-allowlisted host denied (example.com) | PASS | curl: (56) CONNECT tunnel failed, response 403 000 |
| non-allowlisted host denied over SOCKS5 | PASS | curl: (97) cannot complete SOCKS5 connection to example.com. (2) 000 |
| plain http to non-allowlisted host denied | PASS | 403 |
| metadata IP via proxy denied (169.254.169.254) | PASS | 403 |
| allowlisted name resolving to loopback denied (127.0.0.1.nip.io) | PASS | curl: (56) CONNECT tunnel failed, response 403 000 |
| non-allowed port denied (pypi.org:22) | PASS | curl: (56) CONNECT tunnel failed, response 403 000 |
| direct https without proxy fails | PASS | curl: (28) Resolving timed out after 15000 milliseconds 000 |
| direct IP without proxy fails (1.1.1.1) | PASS | curl: (28) Connection timed out after 15003 milliseconds 000 |
| sandbox DNS for external names | PASS | getent failed (exit 124) |
| npm through the proxy (registry.npmjs.org) | PASS | left-pad 1.3.0 |
| git over https through the proxy (github.com) | PASS | 7fd1a60b01f91b314f59955a4e4d4e80d8edf11d	HEAD |
| other host services on 0.0.0.0 reachable? | RISK | http://192.168.128.1:18081/ -> 200 |
| proxy log | INFO | 5 allowed, 6 denied (127.0.0.1.nip.io: resolves to non-public address 127.0.0.1;169.254.169.254: host not in allowlist;example.com: host not in allowlist;pypi.org: port 22 not allowed;) |

Failures: 0
