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

/** Map 4 (Pham Van Dong Boulevard): its own props. Shophouses, trees, cars and the bus come from props_conghoa. */
export const PVD_MODELS: string[] = [
  'arch_rail_bridge',
  'boulevard_median',
  'bridge_branch_pier',
  'bridge_branch_segment',
  'cross_overpass',
  'flood_sign',
  'lane_separator',
  'mall_capturemann',
  'mall_craftmann',
  'poncho_rider_blue',
  'poncho_rider_clear',
  'poncho_rider_pink',
  'poncho_rider_yellow',
  'rain_shelter',
  'ramp_span',
  'sign_gantry_inbound',
  'sign_gantry_outbound',
].map((n) => `models/props_pvd/${n}.glb`);

export const PVD_TEXTURES: string[] = [
  'textures/pvd_road_car_3lane.png',
  'textures/pvd_road_moto_2lane.png',
  'textures/pvd_puddle.png',
  'textures/rain_sky_gradient.png',
  'textures/fx_rain_streaks.png',
  'textures/fx_splash.png',
  'textures/fx_lightning.png',
];
