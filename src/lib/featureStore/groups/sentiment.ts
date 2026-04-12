/**
 * Sentiment feature group: Reddit mentions, sentiment, hype.
 * Loads from public/data/reddit_sentiment.json if available.
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
  compute: (ctx, season) => {
    const results = new Map<PlayerKey, Record<string, number>>();

    // Sentiment data loaded into context by context builder
    const redditBuzz = (ctx.data as any).redditBuzz as Map<string, any> | undefined;
    const redditWindowed = (ctx.data as any).redditWindowed as Map<string, any> | undefined;

    for (const [pk, player] of ctx.players) {
      const rKey = `${player.normalName}:${season}`;
      const buzz = redditBuzz?.get(rKey);
      const win = redditWindowed?.get(rKey);

      results.set(pk, {
        redditMentions1w: win?.mentions_1w || 0,
        redditSentiment1w: win?.sentiment_1w || 0,
        redditHype1w: win?.hype_1w || 0,
        redditMentions4w: win?.mentions_4w || buzz?.mentions || 0,
        redditSentiment4w: win?.sentiment_4w || buzz?.sentiment || 0,
        redditMentionVelocity: win?.mention_velocity || 0,
        redditSentimentVelocity: win?.sentiment_velocity || 0,
      });
    }
    return results;
  },
};

registerGroup(sentimentGroup);
