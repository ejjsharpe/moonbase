import * as Schema from 'effect/Schema';
import { ApplicationError, ApplicationErrorCodeSchema } from './errors.ts';
import { FileTargetSchema } from '../shared/target-schema.ts';
import { optional, struct } from '../shared/schema.ts';

export const ApplicationErrorDTOSchema = struct({
  code: ApplicationErrorCodeSchema,
  message: Schema.String,
  target: optional(FileTargetSchema),
});
const decode = Schema.decodeUnknownSync(ApplicationErrorDTOSchema, {
  onExcessProperty: 'error',
  reportInput: false,
});
export function decodeApplicationErrorDTO(value: unknown): typeof ApplicationErrorDTOSchema.Type {
  try {
    return decode(value);
  } catch {
    throw new ApplicationError({
      code: 'Incompatible',
      message: 'Invalid application error reply.',
    });
  }
}
