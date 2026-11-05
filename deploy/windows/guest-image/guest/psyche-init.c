/*
 * psyche-init: PID 1 of the Psyche sandbox PC guest (statically linked).
 *
 * Does only what a shell script cannot do reliably as PID 1: reaps every orphan, turns signals
 * into a clean shutdown, and powers the machine off or reboots through reboot(2). All setup is
 * in /usr/lib/psyche/boot, all teardown in /usr/lib/psyche/shutdown.
 *
 * Signals (blocked and consumed with sigtimedwait, as tini does):
 *   SIGTERM, SIGUSR2   power off   (/sbin/poweroff sends SIGUSR2; the Hyper-V shutdown
 *                                   integration service runs /sbin/poweroff via the kernel)
 *   SIGUSR1, SIGINT    reboot      (/sbin/reboot; Ctrl-Alt-Del)
 *   SIGCHLD            reap
 */
#define _GNU_SOURCE
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/reboot.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define BOOT "/usr/lib/psyche/boot"
#define SHUTDOWN "/usr/lib/psyche/shutdown"
#define SHUTDOWN_GRACE_SECONDS 25

static pid_t spawn(const char *path) {
  pid_t pid = fork();
  if (pid == 0) {
    sigset_t none;
    sigemptyset(&none);
    sigprocmask(SIG_SETMASK, &none, NULL);
    setsid();
    execl(path, path, (char *)NULL);
    fprintf(stderr, "psyche-init: cannot exec %s: %s\n", path, strerror(errno));
    _exit(127);
  }
  return pid;
}

/* Reaps every exited child; returns true when `watch` was among them. */
static int reap(pid_t watch, int *status_out) {
  int found = 0, status;
  pid_t p;
  while ((p = waitpid(-1, &status, WNOHANG)) > 0) {
    if (p == watch) {
      found = 1;
      if (status_out) *status_out = status;
    }
  }
  return found;
}

static void stop(int reboot_instead) {
  fprintf(stderr, "psyche-init: %s\n", reboot_instead ? "rebooting" : "powering off");
  pid_t pid = spawn(SHUTDOWN);
  if (pid > 0) {
    time_t deadline = time(NULL) + SHUTDOWN_GRACE_SECONDS;
    sigset_t chld;
    sigemptyset(&chld);
    sigaddset(&chld, SIGCHLD);
    struct timespec tick = {0, 200 * 1000 * 1000};
    while (time(NULL) < deadline) {
      if (reap(pid, NULL)) break;
      sigtimedwait(&chld, NULL, &tick);
    }
  }
  kill(-1, SIGTERM);
  sleep(1);
  kill(-1, SIGKILL);
  reap(-1, NULL);
  sync();
  reboot(reboot_instead ? RB_AUTOBOOT : RB_POWER_OFF);
  /* reboot(2) returning means no ACPI/Hyper-V power-off was available. */
  for (;;) pause();
}

int main(void) {
  if (getpid() != 1) {
    fputs("psyche-init must run as PID 1\n", stderr);
    return 1;
  }
  sigset_t set;
  sigemptyset(&set);
  int sigs[] = {SIGCHLD, SIGTERM, SIGUSR1, SIGUSR2, SIGINT, SIGHUP};
  for (size_t i = 0; i < sizeof sigs / sizeof *sigs; i++) sigaddset(&set, sigs[i]);
  sigprocmask(SIG_BLOCK, &set, NULL);

  pid_t boot = spawn(BOOT);
  for (;;) {
    siginfo_t info;
    struct timespec idle = {5, 0};
    int sig = sigtimedwait(&set, &info, &idle);
    int status;
    if (sig < 0) {
      reap(-1, NULL);
      continue;
    }
    switch (sig) {
    case SIGCHLD:
      if (reap(boot, &status) && (!WIFEXITED(status) || WEXITSTATUS(status) != 0))
        fprintf(stderr, "psyche-init: boot script failed (status 0x%x); the guest stays up for diagnosis\n", status);
      break;
    case SIGTERM:
    case SIGUSR2:
      stop(0);
      break;
    case SIGUSR1:
    case SIGINT:
      stop(1);
      break;
    default:
      break;
    }
  }
}
