/** Files (relative to /assets/) that the Cong Hoa Boulevard map needs beyond the shared ones. */
const P = 'models/props_conghoa/';

export const CONG_HOA_MODELS: string[] = [
  'airliner',
  'airport_fence',
  'car_hatch_blue',
  'car_hatch_red',
  'car_sedan_silver',
  'car_sedan_white',
  'car_taxi',
  'city_bus',
  'bus_stop',
  'flyover_pier',
  'median_segment',
  'office_tower',
  'pedestrian_overpass',
  'power_pole',
  'scooter_red',
  'scooter_white',
  'shophouse_a',
  'shophouse_b',
  'shophouse_c',
  'shophouse_d',
  'street_tree_a',
  'street_tree_b',
  'traffic_light',
].map((n) => `${P}${n}.glb`);

export const CONG_HOA_TEXTURES: string[] = [
  'textures/day_road_3lane.png',
  'textures/day_shop_signs.png',
  'textures/day_sky_gradient.png',
];

export const XALO_TEXTURES: string[] = ['textures/xalo_road_4lane.png', 'textures/dusk_sky_gradient.png'];

export const CAT_LAI_TEXTURES: string[] = ['textures/catlai_apron.png', 'textures/xalo_road_4lane.png'];
