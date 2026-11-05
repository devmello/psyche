/*
 * psyche-mount9p: mounts one Plan9 (9P2000.L) share.
 *
 *   psyche-mount9p vsock <port> <aname> <target> <ro|rw>
 *       Connects AF_VSOCK to the host (CID 2, i.e. the Hyper-V parent partition) on <port> and
 *       mounts with trans=fd. This is how the HCS Plan9 server is reached: the host listens on a
 *       Hyper-V socket service per share port, <aname> is the share's AccessName.
 *   psyche-mount9p virtio <tag> <target> <ro|rw>
 *       trans=virtio by mount tag (QEMU's virtio-9p, used by the CI boot test only).
 *
 * Exit: 0 mounted; 1 connect/mount failure (message on stderr); 64 bad arguments.
 * Runs as root from psyche-share. The mount is always nosuid,nodev,noexec-free (tools in a
 * share must run) but never suid, and never a device node.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/socket.h>
#include <unistd.h>
#include <linux/vm_sockets.h>

static int usage(void) {
  fputs("usage: psyche-mount9p vsock <port> <aname> <target> <ro|rw>\n"
        "       psyche-mount9p virtio <tag> <target> <ro|rw>\n", stderr);
  return 64;
}

/* aname/tag are placed in a comma separated option string: refuse anything that could add options. */
static int safe(const char *s) {
  if (!*s || strlen(s) > 128) return 0;
  for (; *s; s++)
    if (*s == ',' || *s == '=' || *s == '\n' || *s == '\0') return 0;
  return 1;
}

int main(int argc, char **argv) {
  unsigned long flags = MS_NOSUID | MS_NODEV | MS_NOATIME;
  const char *target, *mode;
  char opts[512];

  if (argc >= 2 && strcmp(argv[1], "vsock") == 0 && argc == 6) {
    char *end;
    unsigned long port = strtoul(argv[2], &end, 10);
    if (*end || port == 0 || port > 0xffffffffUL || !safe(argv[3])) return usage();
    target = argv[4];
    mode = argv[5];
    int fd = socket(AF_VSOCK, SOCK_STREAM, 0);
    if (fd < 0) { perror("socket(AF_VSOCK)"); return 1; }
    struct sockaddr_vm addr;
    memset(&addr, 0, sizeof addr);
    addr.svm_family = AF_VSOCK;
    addr.svm_cid = VMADDR_CID_HOST;
    addr.svm_port = (unsigned int)port;
    if (connect(fd, (struct sockaddr *)&addr, sizeof addr) < 0) {
      fprintf(stderr, "connect(vsock host:%lu): %s\n", port, strerror(errno));
      return 1;
    }
    snprintf(opts, sizeof opts,
             "trans=fd,rfdno=%d,wfdno=%d,version=9p2000.L,msize=262144,uname=root,aname=%s,access=any",
             fd, fd, argv[3]);
  } else if (argc >= 2 && strcmp(argv[1], "virtio") == 0 && argc == 5) {
    if (!safe(argv[2])) return usage();
    target = argv[3];
    mode = argv[4];
    snprintf(opts, sizeof opts, "trans=virtio,version=9p2000.L,msize=262144,access=any");
    if (mount(argv[2], target, "9p", flags | (strcmp(mode, "ro") == 0 ? MS_RDONLY : 0), opts) < 0) {
      fprintf(stderr, "mount 9p virtio %s on %s: %s\n", argv[2], target, strerror(errno));
      return 1;
    }
    return 0;
  } else {
    return usage();
  }

  if (strcmp(mode, "ro") != 0 && strcmp(mode, "rw") != 0) return usage();
  if (strcmp(mode, "ro") == 0) flags |= MS_RDONLY;
  /* source string is only shown in /proc/mounts */
  if (mount("psyche", target, "9p", flags, opts) < 0) {
    fprintf(stderr, "mount 9p on %s: %s\n", target, strerror(errno));
    return 1;
  }
  return 0;
}
