//#region src/serializable.d.ts
type SerializablePrimitive = undefined | null | string | number | boolean;
type NonSerializable =
  | Function
  | symbol
  | bigint
  | Date
  | RegExp
  | Map<unknown, unknown>
  | Set<unknown>
  | WeakMap<object, unknown>
  | WeakSet<object>
  | Error
  | ArrayBuffer
  | SharedArrayBuffer
  | DataView
  | Int8Array
  | Uint8Array
  | Uint8ClampedArray
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | Float32Array
  | Float64Array
  | BigInt64Array
  | BigUint64Array;
type MaxDepth = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
type Increment<D extends unknown[]> = [0, ...D];
type IsMaxDepth<D extends unknown[]> = D["length"] extends MaxDepth["length"]
  ? true
  : false;
type SerializableValue =
  | undefined
  | null
  | string
  | number
  | boolean
  | {
      [key: string]: SerializableValue;
    }
  | SerializableValue[];
type CanSerialize<T, Seen = never, Depth extends unknown[] = []> =
  IsMaxDepth<Depth> extends true
    ? true
    : T extends Seen
      ? true
      : T extends SerializablePrimitive
        ? true
        : T extends NonSerializable
          ? false
          : T extends readonly (infer U)[]
            ? CanSerialize<U, Seen | T, Increment<Depth>>
            : T extends object
              ? unknown extends T
                ? true
                : {
                      [K in keyof T]: CanSerialize<
                        T[K],
                        Seen | T,
                        Increment<Depth>
                      >;
                    } extends { [K in keyof T]: true }
                  ? true
                  : false
              : true;
type CanSerializeReturn<T> = T extends void
  ? true
  : T extends Promise<infer U>
    ? CanSerialize<U>
    : CanSerialize<T>;
type SerializableReturnValue =
  | SerializableValue
  | void
  | Promise<SerializableValue>
  | Promise<void>;
type IsSerializableParam<T, Seen = never, Depth extends unknown[] = []> =
  IsMaxDepth<Depth> extends true
    ? true
    : T extends Seen
      ? true
      : T extends SerializablePrimitive
        ? true
        : T extends NonSerializable
          ? false
          : T extends readonly (infer U)[]
            ? IsSerializableParam<U, Seen | T, Increment<Depth>>
            : T extends object
              ? unknown extends T
                ? true
                : {
                      [K in keyof T]: IsSerializableParam<
                        T[K],
                        Seen | T,
                        Increment<Depth>
                      >;
                    } extends { [K in keyof T]: true }
                  ? true
                  : false
              : true;
type AllSerializableValues<A> = A extends [infer First, ...infer Rest]
  ? IsSerializableParam<First> extends true
    ? AllSerializableValues<Rest>
    : false
  : true;
type Method = (...args: any[]) => any;
type IsUnknown<T> = [unknown] extends [T]
  ? [T] extends [unknown]
    ? true
    : false
  : false;
type UnwrapPromise<T> = T extends Promise<infer U> ? U : T;
type RPCMethod<T = Method> = T extends Method
  ? T extends (...arg: infer A) => infer R
    ? AllSerializableValues<A> extends true
      ? CanSerializeReturn<R> extends true
        ? T
        : IsUnknown<UnwrapPromise<R>> extends true
          ? T
          : never
      : never
    : never
  : never;
//#endregion
export { Method, RPCMethod, SerializableReturnValue, SerializableValue };
//# sourceMappingURL=serializable.d.ts.map
