import pc from "picocolors";

export function success(message) {
  console.log(pc.green(`✓ ${message}`));
}

export function skipped(message) {
  console.log(pc.dim(`- ${message}`));
}

export function warn(message) {
  console.log(pc.yellow(`! ${message}`));
}

export function error(message) {
  console.error(pc.red(`✗ ${message}`));
}
