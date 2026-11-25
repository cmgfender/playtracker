// EA's PGA Tour golf: PGA Tour Golf, Tiger Woods PGA Tour, then Rory McIlroy and EA Sports PGA Tour.
// The format is described in ../franchises.js. 2K's PGA Tour 2K games are another series: no
// prefix here takes them.
export default {
  id: 'pga-tour', name: 'PGA Tour', aliases: ['PGA Tour', 'EA Sports PGA Tour', 'Tiger Woods PGA Tour'],
  prefix: ['tiger woods', 'rory mcilroy', 'ea sports pga tour'],
  eras: [
    ['PGA Tour Golf', 'PGA Tour Golf', "EA's golf before Tiger Woods, from DOS and Amiga to the Mega Drive and PlayStation"],
    ['Tiger Woods 99 PGA Tour Golf', 'Tiger Woods', "Tiger Woods's name on every game from 1998 to 2013"],
    ['Rory McIlroy PGA Tour', 'Frostbite', 'The Frostbite engine: Rory McIlroy PGA Tour, then EA Sports PGA Tour'],
  ],
  entries: [
    [1990, 'PGA Tour Golf'],
    [1993, 'PGA Tour Golf II'],
    [1994, 'PGA Tour Golf III'],
    [1995, 'PGA Tour 96'],
    [1996, 'PGA Tour 97'],
    [1997, 'PGA Tour 98'],
    [1998, 'Tiger Woods 99 PGA Tour Golf'],
    [1999, 'Tiger Woods PGA Tour 2000'],
    [2000, 'Tiger Woods PGA Tour 2001'],
    [2001, 'Tiger Woods PGA Tour 2002'],
    [2002, 'Tiger Woods PGA Tour 2003'],
    [2003, 'Tiger Woods PGA Tour 2004'],
    [2004, 'Tiger Woods PGA Tour 2005'],
    [2005, 'Tiger Woods PGA Tour 06'],
    [2006, 'Tiger Woods PGA Tour 07'],
    [2007, 'Tiger Woods PGA Tour 08'],
    [2008, 'Tiger Woods PGA Tour 09'],
    [2009, 'Tiger Woods PGA Tour 10'],
    [2010, 'Tiger Woods PGA Tour 11'],
    [2011, 'Tiger Woods PGA Tour 12: The Masters', 'main', { aka: ['Tiger Woods PGA Tour 12'] }],
    [2012, 'Tiger Woods PGA Tour 13'],
    [2013, 'Tiger Woods PGA Tour 14'],
    [2015, 'Rory McIlroy PGA Tour'],
    [2023, 'EA Sports PGA Tour'],
  ],
};
