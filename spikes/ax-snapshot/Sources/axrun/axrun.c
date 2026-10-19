// axrun: spawn AXSnap.app's binary with TCC responsibility disclaimed, so the Accessibility
// grant is checked against AXSnap.app itself instead of whatever launched us (a terminal,
// Claude Code, node). Same pattern as Claude.app's `disclaimer` helper. Private SPI.
#include <dlfcn.h>
#include <limits.h>
#include <mach-o/dyld.h>
#include <libgen.h>
#include <spawn.h>
#include <stdio.h>
#include <string.h>
#include <sys/wait.h>
extern char **environ;
int main(int argc, char **argv) {
    char self[PATH_MAX], target[PATH_MAX];
    uint32_t n = sizeof self;
    if (_NSGetExecutablePath(self, &n) != 0) return 127;
    snprintf(target, sizeof target, "%s/AXSnap.app/Contents/MacOS/axsnap", dirname(self));
    posix_spawnattr_t attr;
    posix_spawnattr_init(&attr);
    int (*disclaim)(posix_spawnattr_t *, int) = dlsym(RTLD_DEFAULT, "responsibility_spawnattrs_setdisclaim");
    if (disclaim) disclaim(&attr, 1); else fprintf(stderr, "axrun: disclaim SPI missing\n");
    argv[0] = target;
    pid_t pid;
    int rc = posix_spawn(&pid, target, NULL, &attr, argv, environ);
    if (rc != 0) { perror("posix_spawn"); return 127; }
    int st = 0;
    waitpid(pid, &st, 0);
    return WIFEXITED(st) ? WEXITSTATUS(st) : 128;
}
