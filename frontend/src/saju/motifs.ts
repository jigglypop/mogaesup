import type { Element } from './elements';

// What a home's island can hold besides its house: a fixed set of small things a Builder draws well at the village's
// scale, each with the places it may stand and the houses it suits. A chart's pillars choose among them (see mulsang);
// what each one looks like is said once here, so every builder draws the same thing for the same name. They dress the
// house and must not crowd it. Nothing here is a second building: what has walls and a roof of its own is shrunk to a
// thing no bigger than the porch (a pavilion one sits in, a wheel without its mill). Each keeps under the reach its
// place allows ({@link PLACE_REACH}), round and soft rather than fine and spiky; only what is laid along a line (a
// wall, the wood's edge, a stream, a strand of sand) runs longer, and that keeps to the island's far edges and garden.
// What grows, flowers or lives keeps to the island's one season (mulsang Season): a look says how it is in its
// months, and out of them it stands bare, green, empty or under snow as that season has it, never in flower against it.

/** Which pillar's part of the island: the land and its far shore, the garden, the house, the fruit and small life at the front. */
export type Zone = 'land' | 'garden' | 'house' | 'details';

/**
 * Where on an island a motif stands, as the untouched camera sees it: it looks from the south-east, down toward the
 * north-west, so what is nearer the south-east corner is nearer the viewer. The house faces south, and the places run
 * from the far side of the island to the near one as the pillars grow toward the viewer.
 * - `back`: the far ground behind the house, farther than its back wall and clear of it to one side on the screen, so
 *   what stands taller than the eaves shows past the roof (the edge of the far wood).
 * - `shore`: a far bank, on the north or the west side beyond the house; never a near one.
 * - `side`: the garden beside the house at about its own depth, clear of the roof's shadow (to its west).
 * - `roof`, `front` (the door, the porch, the front wall) and `eaves` (under the front eave, or the door's posts): on
 *   the house, at the places its builder hands out (scene/houses HouseHooks).
 * - `corner`: the near ground in front of the house, toward the camera, where the fruit trees grow.
 * - `path`: beside the path from the door toward the camera (대문 앞).
 * - `life`: what flies, walks or swims about the front yard, the fruit trees and the water before them.
 */
export type Place = 'back' | 'shore' | 'side' | 'roof' | 'front' | 'eaves' | 'corner' | 'path' | 'life';

/** The places each zone draws into. */
export const ZONE_PLACES: Readonly<Record<Zone, readonly Place[]>> = Object.freeze({
  land: Object.freeze(['back', 'shore'] as const),
  garden: Object.freeze(['side'] as const),
  house: Object.freeze(['roof', 'front', 'eaves'] as const),
  details: Object.freeze(['corner', 'path', 'life'] as const),
});

/** What a panel calls each place. */
export const PLACE_NAME: Readonly<Record<Place, string>> = Object.freeze({
  back: '집 뒤 먼 땅',
  shore: '먼 물가',
  side: '뜰',
  roof: '지붕',
  front: '문간',
  eaves: '처마',
  corner: '앞 과수원',
  path: '앞길',
  life: '앞마당',
});

/** What a panel calls each zone. */
export const ZONE_NAME: Readonly<Record<Zone, string>> = Object.freeze({ land: '먼 땅', garden: '뜰', house: '집', details: '앞마당' });

/**
 * The most a thing standing at each place reaches about its foot, in metres. Behind the house a tree may stand taller
 * and wider than the roof, being far; on and before the house everything stays small, so the house stays the heart.
 * On the house a reach is how far the thing spreads over it, not ground it takes. Small life takes no ground.
 */
export const PLACE_REACH: Readonly<Record<Place, number>> = Object.freeze({
  back: 2.2,
  shore: 1.4,
  side: 1.6,
  roof: 0.6,
  front: 0.8,
  eaves: 0.6,
  corner: 1.4,
  path: 1.2,
  life: 1.2,
});

/** Where a thing laid along a line may go: the far edges and the garden, never the house's front. */
export const LONG_PLACES: readonly Place[] = Object.freeze(['back', 'shore', 'side'] as const);

export type MotifId =
  // Trees and what grows tall.
  | 'oldTree'
  | 'forestEdge'
  | 'birches'
  | 'pines'
  | 'willow'
  | 'ginkgo'
  | 'mulberry'
  | 'saplings'
  | 'pomegranate'
  | 'bamboo'
  | 'fruitTree'
  // Stone, earth and what stands on the land.
  | 'rockHill'
  | 'standingStones'
  | 'sotdae'
  | 'stoneWall'
  | 'earthWall'
  | 'pavilion'
  | 'beacon'
  | 'kiln'
  // Water.
  | 'waterwheel'
  | 'well'
  | 'brook'
  | 'pond'
  | 'spring'
  | 'rainCloud'
  // The shore.
  | 'pearlShell'
  | 'goldSand'
  | 'sandbank'
  | 'crystals'
  | 'boat'
  // The garden.
  | 'hearth'
  | 'bonfire'
  | 'jars'
  | 'vegetableRows'
  | 'sunflowers'
  | 'irises'
  | 'forsythia'
  | 'swing'
  | 'clothesline'
  | 'beehive'
  | 'dirtPath'
  | 'gate'
  | 'bonsai'
  | 'flowerArch'
  | 'stringLights'
  | 'candles'
  // On the house.
  | 'weathercock'
  | 'lightningRod'
  | 'sunDisc'
  | 'gourds'
  | 'rainChain'
  | 'magpie'
  | 'swallowNest'
  | 'ivy'
  | 'gilt'
  | 'hairpin'
  | 'net'
  | 'fishTrap'
  | 'waterJar'
  | 'brazier'
  | 'silkLantern'
  | 'umbrella'
  | 'baskets'
  | 'mill'
  | 'woodpile'
  | 'jige'
  | 'windChime'
  | 'drying'
  | 'ipchun'
  | 'blind'
  // By the path.
  | 'pots'
  | 'stoneLamp'
  | 'signpost'
  | 'cart'
  | 'mushrooms'
  // Small life.
  | 'butterflies'
  | 'fireflies'
  | 'chicks'
  | 'dragonflies'
  | 'ducks'
  | 'sparrows';

/**
 * What draws a motif today: `ready` an existing helper (plants, arch, a Life kind) draws it as it is; `adapt` code that
 * exists for something else (a yard emblem or keepsake, a house's garden) is to be lifted out or extended; `new` needs
 * a helper.
 */
export type Readiness = 'ready' | 'adapt' | 'new';

export type Motif = {
  /** `버드나무`. */
  ko: string;
  places: readonly Place[];
  /** How it is drawn, and from what. */
  look: string;
  /** About how far it reaches from its foot, in metres (on the house, how far it spreads over it): what others stand clear of. */
  reach: number;
  /** Laid along a line (a wall, the wood's edge, a stream, a strand of sand): `reach` is half its length. */
  long?: true;
  /** The houses it suits, by their element: a roof or a door it would look wrong on passes it over. Every house when left out. */
  fits?: readonly Element[];
  /** Whether part of it moves: that part is a small component held still by useStill/useAnimation for pictures. */
  moves: boolean;
  build: Readiness;
  /** The kinds it comes in, each with its Korean name. Without one it is drawn in its plain form. */
  variants?: Readonly<Record<string, string>>;
};

const CATALOGUE: Record<MotifId, Motif> = {
  oldTree: {
    ko: '당산나무',
    places: ['back'],
    look: 'A broad old zelkova taller than the roof, standing back in the far wood: a straw rope hung with white paper strips about its trunk and a ring of flat stones to sit on at its foot (plants.tree, girth 0.3; the 甲 emblem in yard.ts is its younger form).',
    reach: 2.2,
    moves: false,
    build: 'adapt',
  },
  forestEdge: {
    ko: '숲 가장자리',
    places: ['back'],
    look: 'Three to five trees of mixed heights along the far shore, a fir, a broad-leaved tree and a birch, ferns at their feet; tallest at the back, stepping down toward the house (plants.conifer, tree, birch).',
    reach: 3,
    long: true,
    moves: false,
    build: 'ready',
  },
  birches: {
    ko: '자작나무 숲',
    places: ['back'],
    look: 'Three or four white-barked birches standing close, their light crowns in the season (plants.birch).',
    reach: 1.6,
    moves: false,
    build: 'ready',
  },
  pines: {
    ko: '소나무와 잣나무',
    places: ['back', 'side'],
    look: 'A crooked red-barked pine with a tall straight 잣나무 beside it, its five-needled crown darker and denser, a few rocks at their feet; evergreen whatever the season (plants.pine, a straight plants.conifer).',
    reach: 1.6,
    moves: false,
    build: 'ready',
  },
  willow: {
    ko: '버드나무',
    places: ['back', 'side'],
    look: 'A willow leaning out over the bank or the pond, its streamers nearly touching the water (plants.willow).',
    reach: 1.6,
    moves: false,
    build: 'ready',
  },
  ginkgo: {
    ko: '은행나무',
    places: ['back'],
    look: 'An upright ginkgo whose crown turns gold, as if gilded, in autumn, fan leaves fallen gold about its foot then (plants.tree with the season’s leaves, yellow in autumn; pad sprigs on the lawn).',
    reach: 1.8,
    moves: false,
    build: 'ready',
  },
  mulberry: {
    ko: '뽕나무',
    places: ['back', 'side', 'corner'],
    look: 'A low spreading mulberry in its state: bare in winter, young leaves in spring, hung with dark purple berries (오디) in early summer; a small basket of its leaves at its foot (plants.tree, fruit by its state).',
    reach: 1.4,
    moves: false,
    build: 'ready',
  },
  saplings: {
    ko: '어린 나무',
    places: ['back', 'side'],
    look: 'Three young trees in a row, each tied to its stake with a band of straw, round crowns no higher than the eaves (small plants.tree, a b.box stake each).',
    reach: 1.4,
    moves: false,
    build: 'adapt',
  },
  pomegranate: {
    ko: '석류나무',
    places: ['back', 'side', 'corner'],
    look: 'A small rounded tree of glossy leaves in its state: red-orange flowers in high summer, red fruit in autumn, each with a little crown at its tip and one split to show its seeds like jewels; bare in winter (plants.tree; a fruit is a ball and a small cone).',
    reach: 1.4,
    moves: false,
    build: 'new',
  },
  bamboo: {
    ko: '대숲',
    places: ['back', 'side'],
    look: 'A clump of a dozen bamboo canes, green in every season (plants.bamboo).',
    reach: 1,
    moves: false,
    build: 'ready',
  },
  fruitTree: {
    ko: '과실나무',
    places: ['corner'],
    look: 'Small fruit trees of one kind in the near ground, in the state their kind is in at the island’s season (see mulsang PHENOLOGY): bare with snow on the boughs, in bud, in blossom, in leaf, hung with fruit, or bare but for a few fruit left for the magpies (까치밥). The grape is a vine over a frame of poles.',
    reach: 1.4,
    moves: false,
    build: 'adapt',
    variants: {
      camellia: '동백나무',
      plum: '매화나무',
      cherry: '벚나무',
      peach: '복숭아나무',
      nankingCherry: '앵두나무',
      apricot: '살구나무',
      grape: '포도 시렁',
      persimmon: '감나무',
      citron: '유자나무',
    },
  },

  rockHill: {
    ko: '바위 언덕',
    places: ['back', 'side'],
    look: 'A 석가산: mossy grey rocks piled into a small hill no higher than the eaves, a pine on its shoulder and mist about its top (the 戊 emblem in yard.ts). `lit` sets a lantern glowing in a hollow at its foot.',
    reach: 1.4,
    moves: false,
    build: 'adapt',
    variants: { lit: '등불 켠 바위 언덕' },
  },
  standingStones: {
    ko: '선돌',
    places: ['back'],
    look: 'Two or three tall narrow stones standing in the grass, lichen on their tops, the tallest about as high as the eaves (rock sprigs stretched tall).',
    reach: 0.9,
    moves: false,
    build: 'new',
  },
  sotdae: {
    ko: '솟대',
    places: ['back', 'path'],
    look: 'Two or three thin poles of different heights, each with a little carved wooden duck on its top looking out over the land (b.limb poles, a duck of b.ball and b.cone).',
    reach: 0.4,
    moves: false,
    build: 'new',
  },
  stoneWall: {
    ko: '돌담',
    places: ['back'],
    look: 'A low wall of fieldstones along the far shore, open where the bridges land (arch.stoneWall).',
    reach: 3,
    long: true,
    moves: false,
    build: 'ready',
  },
  earthWall: {
    ko: '토담',
    places: ['back', 'side'],
    look: 'A low wall of yellow earth with round stones pressed into it and a little roof of tiles along its top, along the far shore or round the garden, open where a way goes through (a plaster box, arch.slope tiles).',
    reach: 3,
    long: true,
    moves: false,
    build: 'new',
  },
  pavilion: {
    ko: '정자',
    places: ['back'],
    look: 'A little open pavilion no bigger than the porch, back in the far wood: four posts on a floor of boards raised a step, a small hipped roof with its corners turned up, and nothing inside but a mat to sit on (b.box, b.prism).',
    reach: 1.1,
    moves: false,
    build: 'new',
  },
  beacon: {
    ko: '봉화대',
    places: ['back'],
    look: 'A waist-high cairn of stacked stones with an iron fire bowl on its top, the fire alight and a thread of smoke going up (b.cyl courses; life fire and smoke).',
    reach: 0.6,
    moves: true,
    build: 'new',
  },
  kiln: {
    ko: '옹기 가마',
    places: ['back'],
    look: 'A small round kiln of clay like a beehive, waist-high, its fire mouth glowing and a short chimney at its back, two jars cooling beside it (b.dome, arch.jar; life fire and smoke).',
    reach: 1,
    moves: true,
    build: 'new',
  },

  waterwheel: {
    ko: '물레방아',
    places: ['back', 'side'],
    look: 'A little wooden wheel on two posts turning under a trough of falling water, without a mill house (the wheel a b.ring with paddles, which turns; a b.box trough).',
    reach: 1,
    moves: true,
    build: 'new',
  },
  well: {
    ko: '우물',
    places: ['back', 'side'],
    look: 'A round well of dressed stone under a little roof on two posts, its bucket on the rope (arch.well).',
    reach: 0.8,
    moves: false,
    build: 'ready',
  },
  brook: {
    ko: '시냇물',
    places: ['back', 'side'],
    look: 'A narrow stream winding from a spring among rocks to the shore, stepping stones across it and ferns along it: on an estate, its own stream dressed so (terrain ponds, plants.steppingStones; life ripples).',
    reach: 3,
    long: true,
    moves: true,
    build: 'new',
  },
  pond: {
    ko: '연못',
    places: ['side'],
    look: 'A small round pond with stones about it, lily pads and a flower or two in summer, two or three koi; in the snow months a skin of ice at its edges and the koi slow under it (a terrain pond the site must be told of first, dressPond, plants.lilies; life koi).',
    reach: 1.6,
    moves: true,
    build: 'adapt',
  },
  spring: {
    ko: '옹달샘',
    places: ['side', 'front', 'path'],
    look: 'A stone basin fed by a bamboo pipe, a gourd ladle across its rim and a lily pad on the water; by the porch, a small one at its corner (the 수 keepsake in yard.ts).',
    reach: 0.6,
    moves: true,
    build: 'adapt',
  },
  rainCloud: {
    ko: '꼬마 비구름',
    places: ['side'],
    look: 'A small round cloud of white puffs over the garden letting a soft drizzle fall into the flowers, ripples where it lands, drifting a little; in the snow months it lets fall a few flakes instead (puff sprigs; a moving rain). `storm` is a little greyer and flickers from inside now and then.',
    reach: 1,
    moves: true,
    build: 'new',
    variants: { storm: '번개 치는 구름' },
  },

  pearlShell: {
    ko: '진주조개',
    places: ['shore', 'front', 'path'],
    look: 'A clam lying open, pearly pink inside, three or four pearls in it glinting softly: large among the far bank’s rocks, small on the porch or by the path (two b.dome halves hinged, b.ball pearls with a faint glow).',
    reach: 0.6,
    moves: false,
    build: 'new',
  },
  goldSand: {
    ko: '금모래',
    places: ['shore'],
    look: 'A curve of golden sand along a far bank, gold flecks in it catching the light, a few smooth stones (the bank sand; pebble sprigs with a metal finish).',
    reach: 2,
    long: true,
    moves: false,
    build: 'new',
  },
  sandbank: {
    ko: '모래톱',
    places: ['shore'],
    look: 'A pale sandy spit running into the water off a far bank, shells in pinks and creams scattered on it and a piece of driftwood (the bank sand; pad and puff sprigs).',
    reach: 2,
    long: true,
    moves: false,
    build: 'new',
  },
  crystals: {
    ko: '수정 바위',
    places: ['shore', 'path'],
    look: "Clear and violet crystals standing out of a dark rock, glinting (the 辛 emblem's crystals in yard.ts, without the plinth).",
    reach: 0.5,
    moves: false,
    build: 'adapt',
  },
  boat: {
    ko: '나룻배',
    places: ['shore'],
    look: 'A rowing boat tied up by a far bank or the jetty, bobbing (arch.boat, its bob new).',
    reach: 1.4,
    moves: true,
    build: 'adapt',
  },

  hearth: {
    ko: '아궁이와 가마솥',
    places: ['side'],
    look: 'An outdoor hearth of mud and stones, a black iron pot on it under a wooden lid, a fire in its mouth and steam from the lid (b.cyl, b.dome; life fire and smoke).',
    reach: 0.7,
    moves: true,
    build: 'new',
  },
  bonfire: {
    ko: '모닥불',
    places: ['side'],
    look: "A ring of stones on gravel, logs leaning together alight, stumps to sit on round it (the fire house's fire garden in homes.ts).",
    reach: 1.3,
    moves: true,
    build: 'adapt',
  },
  jars: {
    ko: '장독대',
    places: ['side', 'path'],
    look: 'Onggi jars large and small on a raised stone platform; by the path, two or three small ones (arch.jar on a b.box).',
    reach: 1.2,
    moves: false,
    build: 'ready',
  },
  vegetableRows: {
    ko: '텃밭',
    places: ['side'],
    look: "Three short mounded rows in dark soil, of what grows in the season: greens and chillies in summer, cabbages in autumn, straw over the rows in winter (scene/props kitchenGarden, or the 己 emblem's rows).",
    reach: 1.2,
    moves: false,
    build: 'adapt',
  },
  sunflowers: {
    ko: '해바라기',
    places: ['back', 'side'],
    look: "A row of tall sunflowers, their faces turned to the light (the 丙 emblem's sunflowers in yard.ts); out of their season, their dry stalks with the seed heads bowed.",
    reach: 1,
    moves: false,
    build: 'adapt',
  },
  irises: {
    ko: '붓꽃',
    places: ['side'],
    look: 'A bed of upright sword-shaped leaves, blue-violet irises among them in late spring and early summer, by water when the garden has some (plants.flowerBed with tall frond leaves).',
    reach: 0.8,
    moves: false,
    build: 'ready',
  },
  forsythia: {
    ko: '개나리 울타리',
    places: ['side'],
    look: 'A low arching hedge of forsythia, thick with yellow bells in spring and green after, bare twigs in winter (plants.bush in a row, its blooms by the season).',
    reach: 1.4,
    moves: false,
    build: 'ready',
  },
  swing: {
    ko: '그네',
    places: ['side', 'path'],
    look: 'A swing on two ropes from a branch, or from a frame of two posts and a beam, its wooden seat swaying a little (b.box, b.limb ropes).',
    reach: 0.9,
    moves: true,
    build: 'new',
  },
  clothesline: {
    ko: '비단 빨랫줄',
    places: ['side'],
    look: 'A line between two posts with lengths of silk drying on it in soft colours (arch.clothesline).',
    reach: 1.4,
    moves: false,
    build: 'ready',
  },
  beehive: {
    ko: '벌통',
    places: ['side'],
    look: "Two or three wooden hive boxes on a flat stone, a few bees coming and going about the flowers while anything is in flower (b.box; bees moving like the fireflies' motes).",
    reach: 0.6,
    moves: true,
    build: 'new',
  },
  dirtPath: {
    ko: '흙길',
    places: ['side'],
    look: "The garden's way as packed earth between edging stones, wildflowers along its sides, in place of stepping stones (a bare strip of yard ground, plants.rock, flowerBed).",
    reach: 0.5,
    moves: false,
    build: 'new',
  },
  gate: {
    ko: '일각문',
    places: ['side'],
    look: "A small gate where the garden's way goes through its wall or hedge: two posts, two leaves of boards standing open and a little tiled roof over it (b.box, arch.gableRoof).",
    reach: 0.8,
    moves: false,
    build: 'new',
  },
  bonsai: {
    ko: '분재',
    places: ['side', 'front', 'path'],
    look: 'Two or three miniature pines in shallow pots on a stone bench, or one on the porch or on a flat stone by the path; `pomegranate` is a little pomegranate in its pot, in its state (arch.pot, a small plants.pine or tree).',
    reach: 0.6,
    moves: false,
    build: 'adapt',
    variants: { pomegranate: '석류 분재' },
  },
  flowerArch: {
    ko: '꽃 아치',
    places: ['side'],
    look: "An arch over the garden's way that roses and wisteria have climbed, in flower in their months and green or bare after (the 乙 emblem's trellis in yard.ts).",
    reach: 0.8,
    moves: false,
    build: 'adapt',
  },
  stringLights: {
    ko: '줄등',
    places: ['side', 'path'],
    look: "Lights strung between two posts over the garden or along the path (the fire garden's strung lights in homes.ts), the lights by their kind.",
    reach: 1.2,
    moves: false,
    build: 'adapt',
    variants: { bulbs: '꼬마전구 줄등', pearls: '진주 줄등', lotus: '연등', silk: '초롱 줄등' },
  },
  candles: {
    ko: '촛불',
    places: ['side', 'front', 'path'],
    look: 'White wax candles burning on a stone table, on the porch or in small glass jars along the path (the 丁 emblem in yard.ts, smaller). `oilLamp` is an oil lamp (등잔) on its wooden stand, its small flame.',
    reach: 0.5,
    moves: true,
    build: 'adapt',
    variants: { oilLamp: '등잔불' },
  },

  weathercock: {
    ko: '풍향계',
    places: ['roof'],
    look: 'A little iron rooster on an arrow at the top of a rod on the ridge, turning with the wind (b.limb, b.box; the rooster and arrow turn).',
    reach: 0.4,
    fits: ['wood', 'fire', 'water'],
    moves: true,
    build: 'new',
  },
  lightningRod: {
    ko: '피뢰침',
    places: ['roof'],
    look: 'A copper rod on the ridge with a glass ball and a little finial, a wire running down the corner (b.cyl, b.ball, b.limb).',
    reach: 0.3,
    fits: ['fire', 'water'],
    moves: false,
    build: 'new',
  },
  sunDisc: {
    ko: '해 장식',
    places: ['roof'],
    look: "A gilded sun with its rays fixed high on the gable, or in a hip-and-gable roof's 합각, glowing faintly (the 丙 emblem's sun in yard.ts). `rising` is half a sun coming up over a little peak.",
    reach: 0.4,
    fits: ['wood', 'fire', 'metal', 'water'],
    moves: false,
    build: 'adapt',
    variants: { rising: '돋을볕 장식' },
  },
  gourds: {
    ko: '지붕 위 박',
    places: ['roof'],
    look: "White gourds ripening on the roof among their leaves, a vine trailing over the eave: white flowers in summer, gourds in autumn, a dry vine with a gourd or two in winter (the old 초가집's gourds in homes.ts).",
    reach: 0.6,
    fits: ['wood', 'earth'],
    moves: false,
    build: 'adapt',
  },
  rainChain: {
    ko: '빗물 사슬',
    places: ['roof'],
    look: "A chain of little bronze cups from an eave's corner into a stone basin, on a house with gutters (the 癸 emblem's chain in yard.ts).",
    reach: 0.4,
    fits: ['fire', 'water'],
    moves: true,
    build: 'adapt',
  },
  magpie: {
    ko: '까치',
    places: ['roof', 'life'],
    look: 'A magpie on the ridge, its long tail flicking, hopping a step now and then; about the yard, two of them hopping on the grass or the snow (b.ball and b.cone, black and white with a blue sheen on the wings).',
    reach: 0.3,
    moves: true,
    build: 'new',
  },
  swallowNest: {
    ko: '제비집',
    places: ['front', 'eaves'],
    look: "A mud nest under the eave against the front wall; in spring and summer three swallow chicks' heads show over its rim and a swallow darts out and back, after that it stands empty (a b.dome of mud, small balls).",
    reach: 0.3,
    moves: true,
    build: 'new',
  },
  ivy: {
    ko: '담쟁이',
    places: ['front'],
    look: 'Ivy over a stretch of the front or side wall, its leaves in the season: red in autumn, bare stems in winter (plants.vine).',
    reach: 0.8,
    moves: false,
    build: 'ready',
  },
  gilt: {
    ko: '금박 장식',
    places: ['front'],
    look: 'Gold-leaf rings and studs on the door (장석), a thin gilt band about its frame and a small gilt plaque beside it, catching the light (b.ring, b.box in a gold metal finish).',
    reach: 0.3,
    fits: ['fire', 'earth', 'metal', 'water'],
    moves: false,
    build: 'new',
  },
  hairpin: {
    ko: '비녀 노리개',
    places: ['front'],
    look: 'A gilt hairpin and two rings hung on a coloured cord by the door, a silk tassel below them, swaying (b.limb, b.ring, puff sprigs).',
    reach: 0.2,
    fits: ['fire', 'earth', 'metal', 'water'],
    moves: true,
    build: 'new',
  },
  net: {
    ko: '그물과 부표',
    places: ['front'],
    look: 'A fishing net hung to dry on the wall, a few round glass floats caught in it (a mesh of thin b.limb, glass b.ball floats).',
    reach: 0.8,
    fits: ['fire', 'water'],
    moves: false,
    build: 'new',
  },
  fishTrap: {
    ko: '대나무 통발',
    places: ['front', 'path'],
    look: 'A bamboo fish trap, a long woven funnel, hung on the wall by the door or leaning by the path down to the water (b.cyl and b.cone of thin slats).',
    reach: 0.4,
    moves: false,
    build: 'new',
  },
  waterJar: {
    ko: '물항아리',
    places: ['front', 'path'],
    look: 'A big water jar by the door or by the path, a gourd dipper floating in it (arch.jar, b.dome).',
    reach: 0.4,
    moves: false,
    build: 'ready',
  },
  brazier: {
    ko: '화로',
    places: ['front'],
    look: 'A small iron brazier on the porch, its coals glowing (the 화 keepsake in yard.ts).',
    reach: 0.4,
    moves: true,
    build: 'adapt',
  },
  silkLantern: {
    ko: '청사초롱',
    places: ['front', 'path'],
    look: 'Silk lanterns, red with a blue band at top and bottom, lit: a pair hung by the door, or on short posts along the path (b.cyl with a glow).',
    reach: 0.3,
    moves: false,
    build: 'new',
  },
  umbrella: {
    ko: '지우산',
    places: ['front', 'path'],
    look: 'An oiled-paper umbrella left open to dry by the door or by the path, its ribs of bamboo, its paper the colour of persimmon tea (b.cone canopy, b.limb ribs).',
    reach: 0.4,
    moves: false,
    build: 'new',
  },
  baskets: {
    ko: '채반',
    places: ['front'],
    look: 'Round flat baskets of woven bamboo hung on the wall by the door, and one on the porch with red jujubes drying on it; `cocoons` holds mulberry leaves and white silkworm cocoons (b.cyl, puff sprigs).',
    reach: 0.5,
    moves: false,
    build: 'new',
    variants: { cocoons: '누에 채반' },
  },
  mill: {
    ko: '맷돌',
    places: ['front'],
    look: 'A stone hand mill on a straw mat at the edge of the porch, its wooden handle up, a little heap of ground grain beside it (b.cyl stones, b.box handle).',
    reach: 0.4,
    moves: false,
    build: 'new',
  },
  woodpile: {
    ko: '장작더미',
    places: ['front'],
    look: 'Split logs stacked against the side wall (arch.woodpile).',
    reach: 0.8,
    moves: false,
    build: 'ready',
  },
  jige: {
    ko: '지게',
    places: ['front'],
    look: 'A 지게 leaning on the wall, a bundle of brushwood on it (arch.jige).',
    reach: 0.4,
    moves: false,
    build: 'ready',
  },
  windChime: {
    ko: '풍경',
    places: ['front', 'eaves', 'path'],
    look: 'A bronze wind bell with its little fish-shaped plate, hung from the porch’s corner post, an eave or a post by the path, swaying (the 금 keepsake in yard.ts).',
    reach: 0.3,
    moves: true,
    build: 'adapt',
  },
  drying: {
    ko: '처마 밑 걸이',
    places: ['eaves'],
    look: 'What the household hangs under the eave in the season, on strings or a pole (arch.hanging, with new kinds): 씨오쟁이 is a little straw bag of seed hung from the porch post where mice cannot reach it.',
    reach: 0.6,
    moves: false,
    build: 'adapt',
    variants: { seeds: '씨오쟁이', herbs: '쑥과 창포 다발', garlic: '마늘 타래', corn: '옥수수', peppers: '고추', persimmons: '곶감', greens: '시래기', meju: '메주', scoops: '복조리' },
  },
  ipchun: {
    ko: '입춘첩',
    places: ['eaves'],
    look: "Two long sheets of white paper pasted on the door's posts at the start of spring, black brush strokes on them that read as writing from afar without a letter one could read (b.box sheets, thin dark strokes).",
    reach: 0.3,
    moves: false,
    build: 'new',
  },
  blind: {
    ko: '발',
    places: ['eaves', 'front'],
    look: 'A blind of thin bamboo or willow slats half rolled down over a window or the door, tied up with red cords (thin b.box slats).',
    reach: 0.6,
    moves: false,
    build: 'new',
  },

  pots: {
    ko: '화분',
    places: ['path'],
    look: "A few clay pots of flowers in the season's colours along the path (arch.pot).",
    reach: 0.5,
    moves: false,
    build: 'ready',
  },
  stoneLamp: {
    ko: '석등',
    places: ['back', 'path'],
    look: 'A stone lantern, lit: small beside the path, or tall enough to stand for the land behind the house (arch.lantern stone, scaled).',
    reach: 0.4,
    moves: false,
    build: 'ready',
  },
  signpost: {
    ko: '이정표',
    places: ['path'],
    look: 'A wooden post with two or three plain arrow boards pointing different ways, with nothing written on them (b.box).',
    reach: 0.3,
    moves: false,
    build: 'new',
  },
  cart: {
    ko: '손수레',
    places: ['side', 'path'],
    look: 'A small wooden handcart on two spoked wheels, a pumpkin or a sack in it (b.box, b.ring wheels).',
    reach: 0.6,
    moves: false,
    build: 'new',
  },
  mushrooms: {
    ko: '버섯',
    places: ['path'],
    look: "A cluster of red and brown mushrooms on an old log with a fern or two (the wood house's mushrooms in homes.ts).",
    reach: 0.4,
    moves: false,
    build: 'adapt',
  },

  butterflies: {
    ko: '나비',
    places: ['life'],
    look: 'Two or three butterflies over the flowers (life butterfly).',
    reach: 1,
    moves: true,
    build: 'ready',
  },
  fireflies: {
    ko: '반딧불이',
    places: ['life'],
    look: 'Fireflies about the fruit trees and the path (life fireflies).',
    reach: 1.2,
    moves: true,
    build: 'ready',
  },
  chicks: {
    ko: '병아리',
    places: ['life'],
    look: 'A brood of yellow chicks pecking about the yard, hopping a step now and then.',
    reach: 0.8,
    moves: true,
    build: 'new',
  },
  dragonflies: {
    ko: '잠자리',
    places: ['life'],
    look: 'Red dragonflies darting and hovering over the path.',
    reach: 1,
    moves: true,
    build: 'new',
  },
  ducks: {
    ko: '오리',
    places: ['life'],
    look: 'A mother duck and her ducklings paddling in the water off the front shore or on the pond, from spring to autumn; in winter a pair of mandarin ducks.',
    reach: 1.2,
    moves: true,
    build: 'new',
  },
  sparrows: {
    ko: '참새',
    places: ['life'],
    look: 'A few sparrows hopping and pecking about the yard, in the snow in winter, flying up together now and then.',
    reach: 1,
    moves: true,
    build: 'new',
  },
};

function freezeMotif(motif: Motif): Readonly<Motif> {
  Object.freeze(motif.places);
  if (motif.fits) Object.freeze(motif.fits);
  if (motif.variants) Object.freeze(motif.variants);
  return Object.freeze(motif);
}

/** Every motif a home's island may hold, by its id. */
export const MOTIFS: Readonly<Record<MotifId, Readonly<Motif>>> = Object.freeze(
  Object.fromEntries(Object.entries(CATALOGUE).map(([id, motif]) => [id, freezeMotif(motif)])) as Record<MotifId, Readonly<Motif>>,
);

/** Every motif, in the catalogue's order. */
export const MOTIF_IDS: readonly MotifId[] = Object.freeze(Object.keys(CATALOGUE) as MotifId[]);

/** `곶감` for the persimmons hung to dry, `버드나무` for a motif drawn in its plain form. */
export function motifName(motif: MotifId, variant?: string): string {
  const { ko, variants } = MOTIFS[motif];
  return (variant !== undefined ? variants?.[variant] : undefined) ?? ko;
}

/** Whether `motif` suits a house of `style`. */
export const suits = (motif: MotifId, style: Element): boolean => MOTIFS[motif].fits?.includes(style) ?? true;
