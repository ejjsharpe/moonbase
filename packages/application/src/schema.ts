import * as Schema from 'effect/Schema';
import * as SchemaGetter from 'effect/SchemaGetter';
import * as Option from 'effect/Option';
import * as Struct from 'effect/Struct';

export const struct = <const F extends Schema.Struct.Fields>(fields: F) =>
  Schema.Struct(fields).mapFields(Struct.map(Schema.mutableKey));
export const array = <S extends Schema.Constraint>(schema: S) =>
  Schema.mutable(Schema.Array(schema));
// Optional undefined values are omitted, matching the existing wire projection.
export const optional = <T>(schema: Schema.Codec<T>) =>
  Schema.optional(schema).pipe(
    Schema.decodeTo(Schema.optionalKey(schema), {
      decode: SchemaGetter.transformOptional<T, T | undefined>((value) =>
        Option.filter(value, (item): item is T => item !== undefined),
      ),
      encode: SchemaGetter.passthrough<T | undefined, T>({ strict: false }),
    }),
  );

export const voidResult = Schema.declare<void>((value): value is void => value === undefined);
