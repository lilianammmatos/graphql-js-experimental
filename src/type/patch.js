// @flow strict

import { $$asyncIterator } from 'iterall';

import { type ObjMap } from '../jsutils/ObjMap';
import isObjectLike from '../jsutils/isObjectLike';

import { type GraphQLError } from '../error/GraphQLError';
import { getVariableValues } from '../execution/values';

/**
 * Patch Dispatcher Definition
 *
 * A Patch Dispatcher is attached to the execution context and allows us to
 * dispatch patches dynamically and obtain an AsyncIterable that yields each
 * patch in the order that they are resolved.
 *
 * {
 *   'DeferredFragment_label': {
 *     'path,to,parent': [ Patch1, Patch2, Patch3 ]
 *   }
 * }
 */
export class PatchDispatcher {
  _isEmpty: boolean;

  /**
   * this._resolvers maps the label of the deferred fragment spread to a map that maps a
   * string representation of the path to a singleton array with a function that returns data at that path
   * conforming to the iterator protocol.
   *
   * This map is accessed to resolve sub-fields before resolving parent field.
   *
   * E.g.:
   * {
   *   'DeferredFragment_label': {
   *     'path,to,field': [() => ({ value, done: false })]
   *   }
   * }
   */
  _resolvers: ObjMap<ObjMap<(PatchIteratorResult) => void>>;

  /**
   * this._siblings maps the label of the deferred fragment spread to an array of promises that resolve
   * to data conforming to the iterator protocol.
   *
   * This map is accessed when to getting all patches, in order to bundle siblings fields to a deferred label.
   *
   * E.g.:
   *
   * {
   *   'DeferredFragment_label': [
   *     SiblingPromise1,
   *     SiblingPromise2
   *   ]
   * }
   */
  _siblings: ObjMap<Array<Promise<PatchIteratorResult>>>;

  /**
   * this._children maps the label of the deferred fragment spread to a map that maps the a parent path to an array of sub-patches
   * Children are added during the evaluating requests section of GraphQL request.
   *
   * E.g.:
   * {
   *   'DeferredFragment_label': {
   *     'path,to,parent,field': [ChildPatch1, ChildPatch2],
   *   }
   * }
   */
  _children: ObjMap<ObjMap<Array<Patch>>>;

  constructor() {
    this._isEmpty = true;
    this._resolvers = Object.create(null);
    this._siblings = Object.create(null);
    this._children = Object.create(null);
  }

  addChild(patch: Patch, label: string, path: string) {
    setValue(this._children, patch, label, path);
  }

  dispatch(patch: Patch, label: string, path: string): void {
    if (this._isEmpty) {
      this._isEmpty = false;
    }
    patch.then(({ result }) => {
      // Queue patches for sub-fields before resolving parent
      const children = getValue(this._children, label, path);
      if (children) {
        for (const child of children) {
          this.dispatch(child, label, path);
        }
      }
      const resolver = getValue(this._resolvers, label, path);
      // TODO: Rethink getValue() pattern if it's gonna create an odd singleton
      if (resolver && resolver[0]) {
        resolver[0]({ value: result, done: false });
      }
    });

    const result = new Promise<PatchIteratorResult>(resolve => {
      setValue(this._resolvers, resolve, label, path);
    });
    setValue(this._siblings, result, label);
  }

  /* TODO: Flow doesn't support symbols as keys:
     https://github.com/facebook/flow/issues/3258 */
  getPatches(): AsyncIterable<ExecutionPatchResult> | null {
    if (this._isEmpty) {
      return null;
    }
    const results = Object.keys(this._siblings).map(key => {
      const promise = Promise.all(this._siblings[key]).then(values => {
        let commonPath = [];
        // TODO: This reduce here is some jankiness, values should probably be an asyncIterable as well?
        let data = values.reduce((acc, val) => {
          const { value } = val;
          const { path, data } = value;

          commonPath = getCommonPath(path, commonPath);
          return applyPatch(acc, path, data);
        }, {});

        commonPath.forEach(pathEl => {
          data = data[pathEl];
        });

        return {
          value: {
            path: commonPath,
            label: key,
            data: data,
          },
          done: false,
        };
      });
      return Promise.resolve(promise);
    });

    return ({
      next() {
        return results.shift() || this.return();
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

/**
 * Retrives up to two keys from nested map.
 */
function getValue(map: ObjMap<any>, key1: string, key2?: string) {
  let value = undefined;
  value = map[key1];
  if ((Array.isArray(value) || isObjectLike(value)) && key2) {
    value = value[key2];
  }
  return value;
}

/**
 * Sets value at up to two keys on map.
 */
function setValue(
  map: ObjMap<any>,
  value: any,
  key1: string,
  key2?: string,
): mixed {
  const isDeepObject = !!key2;
  if (!map[key1]) {
    map[key1] = isDeepObject ? {} : [];
  }
  if (!isDeepObject) {
    map[key1].push(value);
    return;
  }
  if (!map[key1][key2]) {
    map[key1][key2] = [];
  }
  map[key1][key2].push(value);
}

/**
 * Recursively applies patch data to existing data at the provided path.
 */
// TODO: Get rid of "any" types on arguments
function applyPatch(
  prevData: any,
  path: $ReadOnlyArray<string | number>,
  data: any,
) {
  const [nextPath, ...rest] = path;
  let nextData = data;
  let nextPrevData = undefined;

  if (rest && rest.length) {
    nextPrevData =
      prevData && prevData[nextPath] ? prevData[nextPath] : prevData;
    nextData = applyPatch(nextPrevData, rest, data);
  }

  return {
    ...prevData,
    [nextPath]: nextData,
  };
}

/**
 * Given two paths, returns the common path strings
 * Path 1: ['viewer', 'person', 'name']
 * Path 2: ['viewer', 'person', 'id']
 * Common Path: ['viewer', 'person']
 */
function getCommonPath(
  path: $ReadOnlyArray<string | number>,
  commonPath: Array<string | number>,
): Array<string | number> {
  if (!commonPath || (commonPath && !commonPath.length)) {
    return [...path];
  }
  return path
    .map((pathElement, i) => {
      if (commonPath[i] === pathElement) {
        return pathElement;
      }
    })
    .filter(Boolean);
}

// TODO: Bleh... I don't love this name
type PatchIteratorResult = {|
  value: ExecutionPatchResult,
  done: boolean,
|};

export type ExecutionPatchResult = {
  errors?: $ReadOnlyArray<GraphQLError>,
  data?: ObjMap<mixed> | null,
  path: $ReadOnlyArray<string | number>,
  label: string,
  ...
};

export type Patch = Promise<{|
  label: string,
  path: string,
  result: ExecutionPatchResult,
  // children?: Array<Patch>,
|}>;
