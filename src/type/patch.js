// @flow strict

import { $$asyncIterator } from 'iterall';

import { type ObjMap } from '../jsutils/ObjMap';
import isObjectLike from '../jsutils/isObjectLike';

import { type GraphQLError } from '../error/GraphQLError';

/**
 * Patch Dispatcher Definition
 *
 * A Patch Dispatcher is attached to the execution context and allows us to
 * dispatch patches dynamically and obtain an AsyncIterable that yields each
 * patch in the order that they are resolved, where each patch represents the
 * data for a deferred fragment spread.
 *
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
   * This map is accessed when getting all patches to bundle siblings fields to a deferred label.
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
   * this._children maps the label of the deferred fragment spread to a map that maps the
   * parent path to an array of sub-patches. Children are added during the evaluating
   * requests section of a GraphQL request.
   *
   * E.g.:
   * {
   *   'DeferredFragment_label': {
   *     'path,to,parent,field': [ { patch: ChildPatch1, path: 'path,to,child,field' } ],
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

  deferDispatch(patch: Patch, label: string, parentPath: string, path: string) {
    setValue(this._children, { patch, path }, label, parentPath);
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
          const { patch: childPatch, path: childPath } = child;
          this.dispatch(childPatch, label, childPath);
        }
      }
      const resolver = getValue(this._resolvers, label, path);
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
      // TODO: Revisit "nested promise" logic
      // Nested promises needed because siblings are added asynchronously as
      // patches for sub-fields are resolved. When `getPatches()` is called in execute,
      // only the parent patches are present; however, since they are the last patches to resolve
      // all siblings will have been added once the outer `Promise.all` resolves.
      const promise = Promise.all(this._siblings[key]).then(() =>
        Promise.all(this._siblings[key]).then(values => {
          let pathIntersection = [];
          let patchErrors = [];

          // TODO: Use asyncIterable instead of reduce here or should this logic
          // be applied when adding patches to siblings instead of after the fact?
          let patchData = values.reduce((acc, val) => {
            const { value } = val;
            const { path, data, errors } = value;

            if (errors && errors.length !== 0) {
              patchErrors = [...patchErrors, ...errors];
            }

            pathIntersection = getPathIntersection(path, pathIntersection);

            return applyPatch(acc, path, data);
          }, {});

          // Set data on patch at path intersection
          pathIntersection.forEach(pathIntersectionEl => {
            patchData = patchData[pathIntersectionEl];
          });

          const response =
            patchErrors.length === 0
              ? { data: patchData }
              : { data: patchData, errors: patchErrors };

          return {
            value: {
              path: pathIntersection,
              label: key,
              ...response,
            },
            done: false,
          };
        }),
      );
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
  let value;
  value = map[key1];
  if ((Array.isArray(value) || isObjectLike(value)) && Boolean(key2)) {
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
  const isDeepObject = Boolean(key2);
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
function applyPatch(
  prevData: any,
  path: $ReadOnlyArray<string | number>,
  data: any,
) {
  const [nextPath, ...rest] = path;
  let nextData = data;
  let nextPrevData;

  if (rest && rest.length) {
    nextPrevData =
      prevData && prevData[nextPath] ? prevData[nextPath] : prevData;
    nextData = applyPatch(nextPrevData, rest, data);
  }

  if (Array.isArray(prevData)) {
    prevData[nextPath] = {
      ...prevData[nextPath],
      ...nextData,
    };
    return prevData;
  }

  return {
    ...prevData,
    [nextPath]: nextData,
  };
}

/**
 * Given two paths, returns ther intersection
 * E.g.
 * Path 1: ['hero', 'name']
 * Path 2: ['hero', 'homePlanet']
 * Path Intersection: ['hero']
 */
function getPathIntersection(
  path1: $ReadOnlyArray<string | number>,
  path2: $ReadOnlyArray<string | number>,
): Array<string | number> {
  if (!path2 || (path2 && !path2.length)) {
    return [...path1];
  }
  return path1
    .map((pathElement, i) => {
      if (path2[i] === pathElement) {
        return pathElement;
      }
      return undefined;
    })
    .filter(Boolean);
}

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
|}>;
