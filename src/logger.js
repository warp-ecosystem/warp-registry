import pc from "picocolors";

/**
 * Logs a success message in green with a checkmark.
 * @param {string} message - The message to log.
 */
export function success(message) {
  console.log(pc.green(`✓ ${message}`));
}

/**
 * Logs a skipped message in dim styling with a dash.
 * @param {string} message - The message to log.
 */
export function skipped(message) {
  console.log(pc.dim(`- ${message}`));
}

/**
 * Logs a warning message in yellow with an exclamation mark.
 * @param {string} message - The message to log.
 */
export function warn(message) {
  console.log(pc.yellow(`! ${message}`));
}

/**
 * Logs an error message in red with an X mark to stderr.
 * @param {string} message - The message to log.
 */
export function error(message) {
  console.error(pc.red(`✗ ${message}`));
}
