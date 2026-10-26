// =============================================================================
// Fleet assembly: hero flagship + 16 classed autonomous vessels.
// Each model builder returns a local-space group; the Fleet controller owns
// world placement, headings and wave riding.
// =============================================================================
import { FLEET_ROSTER, BOAT_CLASS } from '../../config.js';
import { createFlagship } from './flagship.js';
import { createVessel } from './fleet-types.js';

export function createFleet(materials) {
  const boats = [];
  for (const spec of FLEET_ROSTER) {
    const boat =
      spec.type === 'flagship'
        ? createFlagship(materials)
        : createVessel(spec.type, spec.variant, materials);
    const cls = BOAT_CLASS[spec.type] || BOAT_CLASS.env;
    boat.roster = spec;
    boat.id = spec.id;
    boat.type = spec.type;
    boat.length = boat.length || cls.length;
    boat.beam = boat.beam || cls.beam;
    boat.wake = boat.wake || {
      length: cls.length,
      beam: cls.beam,
      wakeWidth: cls.wakeWidth,
      wakeStrength: cls.wakeStrength,
    };
    boat.group.name = spec.id;
    boats.push(boat);
  }
  return boats;
}
