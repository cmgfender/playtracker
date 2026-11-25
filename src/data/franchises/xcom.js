// XCOM. The format is described in ../franchises.js.
export default {
  id: 'xcom', name: 'XCOM', aliases: ['XCOM', 'X-COM'], prefix: ['xcom', 'x-com'],
  eras: [
    ['X-COM: UFO Defense', 'MicroProse', 'The original X-COM games'],
    ['XCOM: Enemy Unknown', 'Firaxis', "Firaxis' reboot and its sequels, and 2K Marin's The Bureau"],
  ],
  entries: [
    [1994, 'X-COM: UFO Defense', 'main', { aka: ['UFO: Enemy Unknown', 'X-COM: Enemy Unknown'] }],
    [1995, 'X-COM: Terror from the Deep'],
    [1997, 'X-COM: Apocalypse'],
    [1998, 'X-COM: Interceptor', 'spinoff'],
    [2001, 'X-COM: Enforcer', 'spinoff'],
    [2012, 'XCOM: Enemy Unknown'],
    [2013, 'The Bureau: XCOM Declassified', 'spinoff'],
    [2013, 'XCOM: Enemy Within', 'rerelease', { of: 'XCOM: Enemy Unknown' }],
    [2016, 'XCOM 2'],
    [2020, 'XCOM: Chimera Squad', 'spinoff'],
  ],
};
