// King's Quest. The format is described in ../franchises.js.
export default {
  id: 'kings-quest', name: "King's Quest", aliases: ["King's Quest"], prefix: ["king's quest"],
  eras: [
    ["King's Quest", 'Text parser', 'Typed commands: the first four games and the remake of the first'],
    ["King's Quest V: Absence Makes the Heart Go Yonder!", 'Point and click', 'Icons instead of typing, VGA art and voices: V to VII'],
    ["King's Quest: Mask of Eternity", 'Later games', 'The 3D Mask of Eternity, then an episodic reboot'],
  ],
  entries: [
    [1984, "King's Quest", 'main', { aka: ["King's Quest: Quest for the Crown"] }],
    [1985, "King's Quest II: Romancing the Throne"],
    [1986, "King's Quest III: To Heir Is Human"],
    [1988, "King's Quest IV: The Perils of Rosella"],
    [1990, "King's Quest I: Quest for the Crown", 'remake', { of: "King's Quest" }],
    [1990, "King's Quest V: Absence Makes the Heart Go Yonder!"],
    [1992, "King's Quest VI: Heir Today, Gone Tomorrow"],
    [1994, "King's Quest VII: The Princeless Bride"],
    [1998, "King's Quest: Mask of Eternity"],
    [2015, "King's Quest (2015)", 'main', { aka: ["King's Quest", "King's Quest: The Complete Collection"] }],
  ],
};
