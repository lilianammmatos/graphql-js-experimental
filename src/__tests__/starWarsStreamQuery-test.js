// @flow strict

import { forAwaitEach } from 'iterall';
import { expect } from 'chai';
import { describe, it } from 'mocha';

import { graphql } from '../graphql';

import {
  StarWarsSchema,
  StarWarsSchemaDeferStreamEnabled,
} from './starWarsSchema';

describe('Star Wars Query Stream Tests', () => {
  describe('Compatibility', () => {
    it('Can disable @stream and return would-be streamed data as part of initial result', async () => {
      const query = `
        query HeroFriendsQuery {
          hero {
            friends @stream(initial_count: 0, label: "HeroFriends") {
              id
              name
            }
          }
        }
      `;
      const result = await graphql(StarWarsSchema, query);
      expect(result).to.deep.equal({
        data: {
          hero: {
            friends: [
              {
                id: '1000',
                name: 'Luke Skywalker',
              },
              {
                id: '1002',
                name: 'Han Solo',
              },
              {
                id: '1003',
                name: 'Leia Organa',
              },
            ],
          },
        },
      });
    });
  });

  describe('Basic Queries', () => {
    it('Can @stream an array field', async () => {
      const query = `
        query HeroFriendsQuery {
          hero {
            friends @stream(initial_count: 2, label: "HeroFriends") {
              id
              name
            }
          }
        }
      `;
      const result = await graphql(StarWarsSchemaDeferStreamEnabled, query);
      const { patches: patchesIterable, ...initial } = result;
      expect(initial).to.deep.equal({
        data: {
          hero: {
            friends: [
              {
                id: '1000',
                name: 'Luke Skywalker',
              },
              {
                id: '1002',
                name: 'Han Solo',
              },
            ],
          },
        },
      });

      const patches = [];

      if (patchesIterable) {
        await forAwaitEach(patchesIterable, patch => {
          patches.push(patch);
        });
      }

      expect(patches).to.have.lengthOf(1);
      expect(patches[0]).to.deep.equal({
        label: 'HeroFriends',
        path: ['hero', 'friends', 2],
        data: {
          id: '1003',
          name: 'Leia Organa',
        },
      });
    });
  });

  it('Can @stream multiple selections on the same field', async () => {
    const query = `
      query HeroFriendsQuery {
        hero {
          friends {
            id
          }
          ...FriendsName
          ...FriendsAppearsIn
        }
      }
      fragment FriendsName on Character {
        friends @stream(label: "nameLabel", initial_count: 1) {
          name
        }
      }
      fragment FriendsAppearsIn on Character {
        friends @stream(label: "appearsInLabel", initial_count: 2)  {
          appearsIn
        }
      }
    `;
    const result = await graphql(StarWarsSchemaDeferStreamEnabled, query);
    const { patches: patchesIterable, ...initial } = result;
    expect(initial).to.deep.equal({
      data: {
        hero: {
          friends: [
            {
              id: '1000',
              appearsIn: ['NEWHOPE', 'EMPIRE', 'JEDI'],
              name: 'Luke Skywalker',
            },
            {
              id: '1002',
              appearsIn: ['NEWHOPE', 'EMPIRE', 'JEDI'],
            },
            {
              id: '1003',
            },
          ],
        },
      },
    });

    const patches = [];

    if (patchesIterable) {
      await forAwaitEach(patchesIterable, patch => {
        patches.push(patch);
      });
    }

    expect(patches).to.have.lengthOf(3);
    expect(patches[0]).to.deep.equal({
      data: {
        name: 'Han Solo',
      },
      path: ['hero', 'friends', 1],
      label: 'nameLabel',
    });

    expect(patches[1]).to.deep.equal({
      data: {
        name: 'Leia Organa',
      },
      path: ['hero', 'friends', 2],
      label: 'nameLabel',
    });

    expect(patches[2]).to.deep.equal({
      data: {
        appearsIn: ['NEWHOPE', 'EMPIRE', 'JEDI'],
      },
      path: ['hero', 'friends', 2],
      label: 'appearsInLabel',
    });
  });
});
