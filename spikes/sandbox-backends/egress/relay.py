#!/usr/bin/env python3
"""Dumb TCP relay for Docker backends (spike-02 prototype).

Docker `--internal` networks have no route to the host, so on OrbStack / Docker Desktop /
Colima the sandbox cannot reach the host-side proxy directly. This relay runs in a sidecar
container attached to both the internal network and the default bridge, and forwards
<listen-port> to <host>:<port> (for example host.docker.internal:3128). It holds no policy:
the allowlist lives in the host-side proxy.py.

Usage: relay.py 3128=host.docker.internal:3128 1080=host.docker.internal:1080
"""

import asyncio
import sys


async def pipe(reader, writer):
    try:
        while data := await reader.read(65536):
            writer.write(data)
            await writer.drain()
    except (ConnectionError, OSError):
        pass
    finally:
        writer.close()


def handler(host, port):
    async def handle(cr, cw):
        try:
            ur, uw = await asyncio.wait_for(asyncio.open_connection(host, port), 10)
        except (OSError, asyncio.TimeoutError):
            cw.close()
            return
        await asyncio.gather(pipe(cr, uw), pipe(ur, cw))
    return handle


async def main(specs):
    servers = []
    for spec in specs:
        listen, _, target = spec.partition("=")
        host, _, port = target.rpartition(":")
        servers.append(await asyncio.start_server(handler(host, int(port)), "0.0.0.0", int(listen)))
        print(f"relay :{listen} -> {host}:{port}", flush=True)
    await asyncio.gather(*(s.serve_forever() for s in servers))


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1:]))
