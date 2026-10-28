/** Mirrors SocialPlatform, PostLink, PostMetrics, PostPerformance, ChannelVideo and SocialAccount in @motionily/protocol (performance.ts). */

export enum SocialPlatform {
  Instagram = "instagram",
  TikTok = "tiktok",
  YouTube = "youtube",
}
export const SOCIAL_PLATFORMS: SocialPlatform[] = [SocialPlatform.Instagram, SocialPlatform.TikTok, SocialPlatform.YouTube];
export const SOCIAL_LABEL: Record<SocialPlatform, string> = { instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube Shorts" };

export type PostLink = { platform: SocialPlatform; id: string; url: string | null; publishedAt: string | null };

export type PostMetrics = {
  platform: SocialPlatform;
  fetchedAt: string;
  views: number | null;
  reach: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  avgWatch: number | null;
  skipRate: number | null;
  retention: number[] | null;
  duration: number | null;
};

export type SocialAccount = { platform: SocialPlatform; connected: boolean; handle: string | null; error: string | null };

export type PostPerformance = { postId: string; postedAt: string | null; outdated: boolean; links: PostLink[]; metrics: PostMetrics[] };

export type ChannelVideo = {
  postId: string;
  projectId: string;
  name: string;
  cover: string | null;
  format: string | null;
  duration: number;
  platform: SocialPlatform;
  url: string | null;
  publishedAt: string | null;
  metrics: PostMetrics | null;
};
