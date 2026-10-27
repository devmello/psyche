#!/usr/bin/env python3
"""Host-side egress proxy with a domain allowlist (spike-02 prototype).

Modelled on Anthropic's sandbox-runtime (`srt`) network design: the sandbox has no route to
the internet, and its only way out is an HTTP proxy (CONNECT for TLS, absolute-form for plain
HTTP) and a SOCKS5 proxy, both running on the host and both enforcing the same policy:

  * the target host must match the allowlist (exact name or "*.suffix"); IP literals are
    denied unless listed exactly;
  * the target port must be in the port allowlist (80, 443 by default);
  * the proxy resolves DNS itself and denies the request if ANY resolved address is not
    globally routable (private, loopback, link-local, CGNAT, multicast, reserved), then
    connects to the address it vetted, so DNS rebinding cannot swap in a private address.

Every decision is logged as one JSON line on stderr. Python 3.10+ stdlib only.

Usage: proxy.py --bind 127.0.0.1 --http-port 3128 --socks-port 1080 \
                --allow pypi.org --allow '*.pythonhosted.org'
"""

import argparse
import asyncio
import ipaddress
import json
import socket
import struct
import sys
import time

MAX_HEADER = 64 * 1024
CONNECT_TIMEOUT = 10
IDLE_TIMEOUT = 300


class Policy:
    def __init__(self, allow, ports):
        self.exact = {a.lower().rstrip(".") for a in allow if not a.startswith("*.")}
        self.suffixes = {a[1:].lower().rstrip(".") for a in allow if a.startswith("*.")}
        self.ports = set(ports)

    def host_allowed(self, host):
        h = host.lower().rstrip(".")
        if h in self.exact:
            return True
        try:
            ipaddress.ip_address(h)
            return False  # IP literals only via an exact entry
        except ValueError:
            pass
        return any(h.endswith(s) for s in self.suffixes)

    async def check(self, host, port):
        """Return (ip, None) when allowed, or (None, reason) when denied."""
        if port not in self.ports:
            return None, f"port {port} not allowed"
        if not self.host_allowed(host):
            return None, "host not in allowlist"
        loop = asyncio.get_running_loop()
        try:
            infos = await loop.getaddrinfo(host, port, type=socket.SOCK_STREAM)
        except socket.gaierror as e:
            return None, f"dns: {e}"
        addrs = []
        for info in infos:
            ip = ipaddress.ip_address(info[4][0])
            if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
                ip = ip.ipv4_mapped
            if not ip.is_global or ip.is_multicast:
                return None, f"resolves to non-public address {ip}"
            addrs.append(str(ip))
        if not addrs:
            return None, "no addresses"
        return addrs[0], None


def log(**fields):
    fields["ts"] = round(time.time(), 3)
    print(json.dumps(fields), file=sys.stderr, flush=True)


async def pipe(reader, writer, counter, key):
    try:
        while True:
            data = await asyncio.wait_for(reader.read(65536), IDLE_TIMEOUT)
            if not data:
                break
            counter[key] += len(data)
            writer.write(data)
            await writer.drain()
    except (asyncio.TimeoutError, ConnectionError, OSError):
        pass
    finally:
        try:
            writer.close()
        except Exception:
            pass


async def splice(cr, cw, ur, uw):
    counter = {"up": 0, "down": 0}
    await asyncio.gather(pipe(cr, uw, counter, "up"), pipe(ur, cw, counter, "down"))
    return counter


async def open_upstream(ip, port):
    return await asyncio.wait_for(asyncio.open_connection(ip, port), CONNECT_TIMEOUT)


def split_hostport(value, default_port):
    if value.startswith("["):  # [v6]:port
        host, _, rest = value[1:].partition("]")
        port = int(rest[1:]) if rest.startswith(":") else default_port
        return host, port
    host, sep, port = value.rpartition(":")
    if sep and port.isdigit():
        return host, int(port)
    return value, default_port


# ---- HTTP proxy ------------------------------------------------------------------------

async def handle_http(policy, reader, writer):
    peer = writer.get_extra_info("peername")
    try:
        head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 30)
    except (asyncio.IncompleteReadError, asyncio.LimitOverrunError, asyncio.TimeoutError):
        writer.close()
        return
    lines = head.decode("latin-1").split("\r\n")
    try:
        method, target, version = lines[0].split(" ", 2)
    except ValueError:
        writer.write(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n")
        writer.close()
        return

    if method.upper() == "CONNECT":
        host, port = split_hostport(target, 443)
        rest_path = None
    else:
        if not target.lower().startswith("http://"):
            writer.write(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n")
            writer.close()
            return
        hostport, _, path = target[7:].partition("/")
        host, port = split_hostport(hostport, 80)
        rest_path = "/" + path

    ip, reason = await policy.check(host, port)
    if reason:
        log(proto="http", method=method, host=host, port=port, peer=str(peer), decision="deny", reason=reason)
        body = f"psyche egress proxy: {host}:{port} denied ({reason})\n".encode()
        writer.write(b"HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n"
                     + f"Content-Length: {len(body)}\r\n\r\n".encode() + body)
        await writer.drain()
        writer.close()
        return
    try:
        ur, uw = await open_upstream(ip, port)
    except (OSError, asyncio.TimeoutError) as e:
        log(proto="http", host=host, port=port, ip=ip, decision="error", reason=str(e))
        writer.write(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
        writer.close()
        return

    if rest_path is None:
        writer.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        await writer.drain()
    else:
        # Plain HTTP: rewrite to origin-form, drop proxy headers, one request per connection.
        headers = [h for h in lines[1:] if h and not h.lower().startswith(("proxy-", "connection:"))]
        req = f"{method} {rest_path} {version}\r\n" + "\r\n".join(headers) + "\r\nConnection: close\r\n\r\n"
        uw.write(req.encode("latin-1"))
    counter = await splice(reader, writer, ur, uw)
    log(proto="http", method=method, host=host, port=port, ip=ip, decision="allow", **counter)


# ---- SOCKS5 proxy ----------------------------------------------------------------------

async def handle_socks(policy, reader, writer):
    peer = writer.get_extra_info("peername")

    def reply(code):
        writer.write(struct.pack("!BBBB4sH", 5, code, 0, 1, b"\0\0\0\0", 0))

    try:
        ver, n = await reader.readexactly(2)
        methods = await reader.readexactly(n)
        if ver != 5 or 0 not in methods:
            writer.write(b"\x05\xff")
            writer.close()
            return
        writer.write(b"\x05\x00")
        ver, cmd, _, atyp = await reader.readexactly(4)
        if atyp == 1:
            host = socket.inet_ntop(socket.AF_INET, await reader.readexactly(4))
        elif atyp == 3:
            (ln,) = await reader.readexactly(1)
            host = (await reader.readexactly(ln)).decode("idna")
        elif atyp == 4:
            host = socket.inet_ntop(socket.AF_INET6, await reader.readexactly(16))
        else:
            reply(8)
            writer.close()
            return
        (port,) = struct.unpack("!H", await reader.readexactly(2))
    except (asyncio.IncompleteReadError, UnicodeError):
        writer.close()
        return
    if cmd != 1:  # CONNECT only; no BIND / UDP ASSOCIATE
        reply(7)
        writer.close()
        return
    ip, reason = await policy.check(host, port)
    if reason:
        log(proto="socks5", host=host, port=port, peer=str(peer), decision="deny", reason=reason)
        reply(2)  # connection not allowed by ruleset
        writer.close()
        return
    try:
        ur, uw = await open_upstream(ip, port)
    except (OSError, asyncio.TimeoutError) as e:
        log(proto="socks5", host=host, port=port, ip=ip, decision="error", reason=str(e))
        reply(5)
        writer.close()
        return
    reply(0)
    await writer.drain()
    counter = await splice(reader, writer, ur, uw)
    log(proto="socks5", host=host, port=port, ip=ip, decision="allow", **counter)


async def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bind", action="append", required=True, help="address to listen on (repeatable)")
    ap.add_argument("--http-port", type=int, default=3128)
    ap.add_argument("--socks-port", type=int, default=1080)
    ap.add_argument("--allow", action="append", default=[], help="host or *.suffix (repeatable)")
    ap.add_argument("--allow-port", action="append", type=int, default=[], help="default 80 and 443")
    args = ap.parse_args()
    policy = Policy(args.allow, args.allow_port or [80, 443])

    servers = []
    for addr in args.bind:
        servers.append(await asyncio.start_server(lambda r, w: handle_http(policy, r, w), addr, args.http_port, limit=MAX_HEADER))
        servers.append(await asyncio.start_server(lambda r, w: handle_socks(policy, r, w), addr, args.socks_port))
    log(event="listening", bind=args.bind, http=args.http_port, socks=args.socks_port,
        allow=sorted(policy.exact | {"*" + s for s in policy.suffixes}), ports=sorted(policy.ports))
    await asyncio.gather(*(s.serve_forever() for s in servers))


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
