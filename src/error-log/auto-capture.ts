import type { AppServices } from '../app.js';
import type { AppError } from '../errors.js';

/** Whether an AppError should be auto-captured as an error-log entry. */
export function shouldAutoCapture(services: AppServices, error: AppError): boolean {
  if (!services.config.errorLog.autoCapture) {
    return false;
  }

  return services.config.errorLog.captureClientErrors || error.status >= 500;
}
