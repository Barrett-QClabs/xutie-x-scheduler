import { describe, expect, it } from "vitest";
import { chineseZoneCheck, isChineseText } from "../automation/follow-common.mjs";

describe("keyword follow chinese-zone check", () => {
  it("requires the matched tweet to be lang zh", () => {
    expect(chineseZoneCheck({ tweetLang: "en", name: "小明", bio: "创业者", tweetText: "AI 创业" }).ok).toBe(false);
    expect(chineseZoneCheck({ tweetLang: "ja", name: "小明", bio: "", tweetText: "" }).ok).toBe(false);
  });
  it("accepts chinese name or bio", () => {
    expect(chineseZoneCheck({ tweetLang: "zh", name: "小明", bio: "", tweetText: "" }).ok).toBe(true);
    expect(chineseZoneCheck({ tweetLang: "zh", name: "Tom", bio: "币圈老韭菜 / web3", tweetText: "" }).ok).toBe(true);
  });
  it("rejects japanese (kana) names/bios without falling back to the tweet", () => {
    expect(chineseZoneCheck({ tweetLang: "zh", name: "田中さん", bio: "東京に住んでいます", tweetText: "今天比特币大涨" }).ok).toBe(false);
    expect(chineseZoneCheck({ tweetLang: "zh", name: "LAIKA", bio: "アイボのライカです", tweetText: "今天比特币大涨" }).ok).toBe(false);
  });
  it("falls back to tweet text only when name and bio have no CJK", () => {
    expect(chineseZoneCheck({ tweetLang: "zh", name: "Tom", bio: "Crypto trader", tweetText: "今天比特币大涨了" }).ok).toBe(true);
    expect(chineseZoneCheck({ tweetLang: "zh", name: "Pls Trend", bio: "I love AI", tweetText: "AI is great 好" }).ok).toBe(false);
  });
  it("ignores @mentions and urls", () => {
    expect(isChineseText("@abc 好 https://例子.cn/中文")).toBe(false);
  });
});
