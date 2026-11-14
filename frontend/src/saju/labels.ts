// Korean readings for what jamiblossom gives in Chinese characters: 12운성 and 납음.

const STAGES: Record<string, string> = {
  长生: '장생', 沐浴: '목욕', 冠带: '관대', 临官: '건록', 帝旺: '제왕', 衰: '쇠',
  病: '병', 死: '사', 墓: '묘', 绝: '절', 胎: '태', 养: '양',
};

const NAYIN: Record<string, string> = {
  海中金: '해중금', 炉中火: '노중화', 大林木: '대림목', 路旁土: '노방토', 剑锋金: '검봉금', 山头火: '산두화',
  涧下水: '간하수', 城头土: '성두토', 白蜡金: '백랍금', 杨柳木: '양류목', 泉中水: '천중수', 屋上土: '옥상토',
  霹雳火: '벽력화', 松柏木: '송백목', 长流水: '장류수', 沙中金: '사중금', 山下火: '산하화', 平地木: '평지목',
  壁上土: '벽상토', 金箔金: '금박금', 覆灯火: '복등화', 天河水: '천하수', 大驿土: '대역토', 钗钏金: '차천금',
  桑柘木: '상자목', 大溪水: '대계수', 沙中土: '사중토', 天上火: '천상화', 石榴木: '석류목', 大海水: '대해수',
};

/** `长生` → `장생`; a name this table does not know is shown as it came. */
export const stageKo = (stage: string) => STAGES[stage] ?? stage;
/** `海中金` → `해중금`. */
export const nayinKo = (nayin: string) => NAYIN[nayin] ?? nayin;
