// King's Field. The format is described in ../franchises.js.
// The West numbered them differently: its "King's Field" (1996) is Japan's II, its "King's Field II" is
// Japan's III, so those names are akas told apart by year.
export default {
  id: 'kings-field', name: "King's Field", aliases: ["King's Field"], prefix: ["king's field"],
  entries: [
    [1994, "King's Field"],
    [1995, "King's Field II", 'main', { aka: ["King's Field"] }],
    [1996, "King's Field III", 'main', { aka: ["King's Field II"] }],
    [2001, "King's Field IV", 'main', { aka: ["King's Field: The Ancient City"] }],
  ],
};
