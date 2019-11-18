// @flow strict

import { expect } from 'chai';
import { describe, it } from 'mocha';

import { graphql } from '../graphql';
import { forAwaitEach } from 'iterall';

import { StarWarsSchema } from './starWarsSchema';

describe.only('Star Wars Query Tests', () => {
  describe('Uses fragments to express more complex queries', () => {
    it('Allows us to use a fragment to avoid duplicating content', async () => {
      const query = `
        query UserFragment {
          leia: human(id: "1003") {
            __typename
            id
            ...HumanFragment
          }
          luke: human(id: "1000") {
            __typename
            id
            homePlanet
            ...HumanFragment @defer(label: "DeferLuke")
          }
          han: human(id: "1002") {
            id
            __typename
            name
            ...HumanFragment @defer(label: "DeferHan")
          }
        }

        fragment HumanFragment on Human {
          id
          __typename
          name
          homePlanet
          friends {
            name
          }
        }
      `;
      const result = await graphql(StarWarsSchema, query);
      const { patches: patchesIterable, ...rest } = result;

      expect(rest).to.deep.equal({
        data: {
          han: {
            __typename: 'Human',
            id: '1002',
            name: 'Han Solo',
            homePlanet: null,
            friends: null,
          },
          luke: {
            id: '1000',
            __typename: 'Human',
            name: null,
            homePlanet: 'Tatooine',
            friends: null,
          },
          leia: {
            __typename: 'Human',
            name: 'Leia Organa',
            homePlanet: 'Alderaan',
            id: '1003',
            friends: [
              {
                name: 'Luke Skywalker',
              },
              {
                name: 'Han Solo',
              },
              {
                name: 'C-3PO',
              },
              {
                name: 'R2-D2',
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

      expect(patches).to.have.lengthOf(2);
      expect(patches[0]).to.deep.equal({
        label: 'DeferLuke',
        path: ['luke'],
        data: {
          id: '1000',
          __typename: 'Human',
          name: 'Luke Skywalker',
          homePlanet: 'Tatooine',
          friends: [
            {
              name: 'Han Solo',
            },
            {
              name: 'Leia Organa',
            },
            {
              name: 'C-3PO',
            },
            {
              name: 'R2-D2',
            },
          ],
        },
      });

      expect(patches[1]).to.deep.equal({
        label: 'DeferHan',
        path: ['han'],
        data: {
          id: '1002',
          __typename: 'Human',
          name: 'Han Solo',
          homePlanet: null,
          friends: [
            {
              name: 'Luke Skywalker',
            },
            {
              name: 'Leia Organa',
            },
            {
              name: 'R2-D2',
            },
          ],
        },
      });
    });
  });
});
