/**
 * Common validation utility functions
 */

import { ValidationError } from '../utils/errors.js';

export class ValidationHelpers {
  static validateBoolean(value: any, fieldName: string): void {
    if (value !== undefined && typeof value !== 'boolean') {
      throw new ValidationError(`${fieldName} must be a boolean`, 'sub-config validation');
    }
  }

  static validateString(value: any, fieldName: string): void {
    if (value !== undefined && typeof value !== 'string') {
      throw new ValidationError(`${fieldName} must be a string`, 'sub-config validation');
    }
  }

  static validateNumber(
    value: any,
    fieldName: string,
    options?: { min?: number; max?: number },
  ): void {
    if (value !== undefined) {
      if (typeof value !== 'number') {
        throw new ValidationError(`${fieldName} must be a number`, 'sub-config validation');
      }
      if (options?.min !== undefined && value < options.min) {
        throw new ValidationError(
          `${fieldName} must be at least ${options.min}`,
          'sub-config validation',
        );
      }
      if (options?.max !== undefined && value > options.max) {
        throw new ValidationError(
          `${fieldName} must be at most ${options.max}`,
          'sub-config validation',
        );
      }
    }
  }

  static validateKnownOptions(
    subConfigs: Map<string, any>,
    knownOptions: Set<string>,
    toolName: string,
  ): void {
    for (const [key] of subConfigs) {
      if (!knownOptions.has(key)) {
        const validOptions = Array.from(knownOptions)
          .filter((k) => k !== 'ack_token')
          .join(', ');
        throw new ValidationError(
          `Unknown sub-configuration option '${key}' for ${toolName} tool. Valid options are: ${validOptions}`,
          'sub-config validation',
        );
      }
    }
  }
}
