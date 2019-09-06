// @flow strict

import { $$asyncIterator } from 'iterall';

import { type ObjMap } from '../jsutils/ObjMap';

import { type GraphQLError } from '../error/GraphQLError';

/**
 * Patch Dispatcher Definition
 *
 * A Patch Dispatcher is attached to the execution context and allows us to
 * dispatch patches dynamically and obtain an AsyncIterable that yields each
 * patch in the order that they are resolved.
 */

export class PatchDispatcher {
  resolvers: Array<
    ({|
      value: ExecutionPatchResult,
      done: boolean,
    |}) => void,
  >;

  results: Array<
    Promise<{|
      value: ExecutionPatchResult,
      done: boolean,
    |}>,
  >;

  constructor() {
    this.resolvers = [];
    this.results = [];
  }

  dispatch(patch: Patch): void {
    patch.then(({ patchResult, subPatches }) => {
      // Queue patches for sub-fields before resolving parent
      if (subPatches) {
        for (const subPatch of subPatches) {
          this.dispatch(subPatch);
        }
      }
      const resolver = this.resolvers.shift();
      if (resolver) {
        resolver({ value: patchResult, done: false });
      }
    });
    this.results.push(
      new Promise<{| value: ExecutionPatchResult, done: boolean |}>(resolve => {
        this.resolvers.push(resolve);
      }),
    );
  }

  /* TODO: Flow doesn't support symbols as keys:
     https://github.com/facebook/flow/issues/3258 */
  getAsyncIterable(): AsyncIterable<ExecutionPatchResult> {
    const self = this;
    return ({
      next() {
        return self.results.shift() || this.return();
      },
      return() {
        return Promise.resolve({ value: undefined, done: true });
      },
      [$$asyncIterator]() {
        return this;
      },
    }: any);
  }
}

export type ExecutionPatchResult = {
  errors?: $ReadOnlyArray<GraphQLError>,
  data?: ObjMap<mixed> | null,
  path: $ReadOnlyArray<string | number>,
  ...
};

export type Patch = Promise<{|
  patchResult: ExecutionPatchResult,
  subPatches?: Array<Patch>,
|}>;
