// Guest-side virtio-vsock bridge for spike-06. Node has no AF_VSOCK support, so this tiny
// process owns the vsock side and pumps bytes to a loopback TCP port.
//
//   vsock-bridge listen <vsock-port> <tcp-port>   host → guest: accept vsock, connect 127.0.0.1:<tcp-port>
//   vsock-bridge connect <cid> <vsock-port>       guest → host: stdin/stdout over vsock (CID 2 = host)
#include <arpa/inet.h>
#include <errno.h>
#include <netinet/in.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/vsock.h>
#include <unistd.h>

/* Pumps a<->b until both directions are done. EOF on one side half-closes the other
 * (shutdown SHUT_WR) so a reply still in flight is delivered. b == 0 means stdin/stdout. */
static void pump(int a, int b) {
    struct pollfd p[2] = {{a, POLLIN, 0}, {b, POLLIN, 0}};
    char buf[16384];
    int open = 2;
    while (open > 0) {
        if (poll(p, 2, -1) < 0) { if (errno == EINTR) continue; return; }
        for (int i = 0; i < 2; i++) {
            if (p[i].fd >= 0 && (p[i].revents & (POLLIN | POLLHUP | POLLERR))) {
                ssize_t n = read(p[i].fd, buf, sizeof buf);
                if (n <= 0) {
                    int peer = (i == 0) ? b : a;
                    if (peer == 0) { if (i == 0) return; /* socket closed: done */ }
                    else shutdown(peer, SHUT_WR);
                    p[i].fd = -1;
                    open--;
                    continue;
                }
                int out = (i == 0) ? b : a;
                if (out == 0) out = 1; /* stdin pairs with stdout */
                for (ssize_t off = 0; off < n;) {
                    ssize_t w = write(out, buf + off, n - off);
                    if (w <= 0) return;
                    off += w;
                }
            }
        }
    }
}

static int vsock_socket(void) {
    int s = socket(AF_VSOCK, SOCK_STREAM, 0);
    if (s < 0) { perror("socket(AF_VSOCK)"); exit(1); }
    return s;
}

int main(int argc, char **argv) {
    signal(SIGCHLD, SIG_IGN);
    signal(SIGPIPE, SIG_IGN);
    if (argc == 4 && strcmp(argv[1], "listen") == 0) {
        int s = vsock_socket();
        struct sockaddr_vm a = {0};
        a.svm_len = sizeof a;
        a.svm_family = AF_VSOCK;
        a.svm_cid = VMADDR_CID_ANY;
        a.svm_port = (unsigned)atoi(argv[2]);
        if (bind(s, (struct sockaddr *)&a, sizeof a) < 0) { perror("bind"); return 1; }
        if (listen(s, 16) < 0) { perror("listen"); return 1; }
        fprintf(stderr, "vsock-bridge: vsock:%s -> 127.0.0.1:%s\n", argv[2], argv[3]);
        for (;;) {
            int c = accept(s, NULL, NULL);
            if (c < 0) continue;
            if (fork() == 0) {
                close(s);
                int t = socket(AF_INET, SOCK_STREAM, 0);
                struct sockaddr_in in = {0};
                in.sin_len = sizeof in;
                in.sin_family = AF_INET;
                in.sin_port = htons((unsigned short)atoi(argv[3]));
                in.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
                if (connect(t, (struct sockaddr *)&in, sizeof in) < 0) { perror("connect tcp"); _exit(1); }
                pump(c, t);
                _exit(0);
            }
            close(c);
        }
    }
    if (argc == 4 && strcmp(argv[1], "connect") == 0) {
        int s = vsock_socket();
        struct sockaddr_vm a = {0};
        a.svm_len = sizeof a;
        a.svm_family = AF_VSOCK;
        a.svm_cid = (unsigned)atoi(argv[2]);
        a.svm_port = (unsigned)atoi(argv[3]);
        if (connect(s, (struct sockaddr *)&a, sizeof a) < 0) { perror("connect vsock"); return 1; }
        pump(s, 0);
        return 0;
    }
    fprintf(stderr, "usage: vsock-bridge listen <vport> <tcpport> | connect <cid> <vport>\n");
    return 64;
}
