/**
 * Sentiment feature group: Reddit mentions, sentiment, hype.
 */

import { registerGroup } from '../registry';
import type { FeatureGroup, PlayerKey } from '../types';

export const sentimentGroup: FeatureGroup = {
  def: {
    id: 'sentiment',
    label: 'Reddit Sentiment',
    featureKeys: [
      'redditMentions1w', 'redditSentiment1w', 'redditHype1w',
      'redditMentions4w', 'redditSentiment4w',
      'redditMentionVelocity', 'redditSentimentVelocity',
    ],
    dataDeps: [],
    scope: 'seasonal',
  },
  compute: (ctx, _season) => {
    const results = new Map<PlayerKey, Record<string, number>>();
    for (const [pk] of ctx.players) {
      results.set(pk, {
        redditMentions1w: 0, redditSentiment1w: 0, redditHype1w: 0,
        redditMentions4w: 0, redditSentiment4w: 0,
        redditMentionVelocity: 0, redditSentimentVelocity: 0,
      });
    }
    return results;
  },
};

registerGroup(sentimentGroup);
