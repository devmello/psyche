export function toPowerShellArgs(args: string[]): string[];
export function commandFor(
  step: string,
  args: string[],
  platform?: string,
  shell?: string,
): [string, string[]];
