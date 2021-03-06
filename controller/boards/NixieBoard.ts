/*  nodejs-poolController.  An application to control pool equipment.
Copyright (C) 2016, 2017, 2018, 2019, 2020.  Russell Goldin, tagyoureit.  russ.goldin@gmail.com

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/
import * as extend from 'extend';
import { EventEmitter } from 'events';
import { ncp } from "../nixie/Nixie";
import { utils, Heliotrope, Timestamp } from '../Constants';
import {SystemBoard, byteValueMap, ConfigQueue, ConfigRequest, BodyCommands, FilterCommands, PumpCommands, SystemCommands, CircuitCommands, FeatureCommands, ValveCommands, HeaterCommands, ChlorinatorCommands, ChemControllerCommands, EquipmentIdRange} from './SystemBoard';
import { logger } from '../../logger/Logger';
import { state, ChlorinatorState, ChemControllerState, TemperatureState, VirtualCircuitState, ICircuitState, ICircuitGroupState, LightGroupState, ValveState, FilterState } from '../State';
import { sys, Equipment, Options, Owner, Location, CircuitCollection, TempSensorCollection, General, PoolSystem, Body, Pump, CircuitGroupCircuit, CircuitGroup, ChemController, Circuit, Feature, Valve, ICircuit, Heater, LightGroup, LightGroupCircuit, ControllerType, Filter } from '../Equipment';
import { Protocol, Outbound, Message, Response } from '../comms/messages/Messages';
import { EquipmentNotFoundError, InvalidEquipmentDataError, InvalidEquipmentIdError, ParameterOutOfRangeError } from '../Errors';
import {conn} from '../comms/Comms';
export class NixieBoard extends SystemBoard {
    constructor (system: PoolSystem){
        super(system);
        this._statusInterval = 3000;
        this.equipmentIds.circuits = new EquipmentIdRange(1, function () { return this.start + sys.equipment.maxCircuits - 1; });
        this.equipmentIds.features = new EquipmentIdRange(function () { return 129; }, function () { return this.start + sys.equipment.maxFeatures - 1; });
        this.equipmentIds.circuitGroups = new EquipmentIdRange(function () { return this.start; }, function () { return this.start + sys.equipment.maxCircuitGroups - 1; });
        this.equipmentIds.virtualCircuits = new EquipmentIdRange(function () { return this.start; }, function () { return 254; });
        this.equipmentIds.features.start = 129;
        this.equipmentIds.circuitGroups.start = 193;
        this.equipmentIds.virtualCircuits.start = 237;
        this.valueMaps.circuitFunctions = new byteValueMap([
            [0, { name: 'generic', desc: 'Generic' }],
            [1, { name: 'spillway', desc: 'Spillway' }],
            [2, { name: 'mastercleaner', desc: 'Master Cleaner' }],
            [3, { name: 'chemrelay', desc: 'Chem Relay' }],
            [4, { name: 'light', desc: 'Light', isLight: true }],
            [5, { name: 'intellibrite', desc: 'Intellibrite', isLight: true }],
            [6, { name: 'globrite', desc: 'GloBrite', isLight: true }],
            [7, { name: 'globritewhite', desc: 'GloBrite White', isLight: true }],
            [8, { name: 'magicstream', desc: 'Magicstream', isLight: true }],
            [9, { name: 'dimmer', desc: 'Dimmer', isLight: true }],
            [10, { name: 'colorcascade', desc: 'ColorCascade', isLight: true }],
            [11, { name: 'mastercleaner2', desc: 'Master Cleaner 2' }],
            [12, { name: 'pool', desc: 'Pool', hasHeatSource: true }],
            [13, { name: 'spa', desc: 'Spa', hasHeatSource: true }]
        ]);
        this.valueMaps.pumpTypes = new byteValueMap([
            [1, { name: 'ss', desc: 'Single Speed', maxCircuits: 0, hasAddress: false, hasBody: true, maxRelays: 1 }],
            [2, { name: 'ds', desc: 'Two Speed', maxCircuits: 8, hasAddress: false, hasBody: false, maxRelays: 2 }],
            [3, { name: 'vs', desc: 'Intelliflo VS', maxPrimingTime: 6, minSpeed: 450, maxSpeed: 3450, maxCircuits: 8, hasAddress: true }],
            [4, { name: 'vsf', desc: 'Intelliflo VSF', minSpeed: 450, maxSpeed: 3450, minFlow: 15, maxFlow: 130, maxCircuits: 8, hasAddress: true }],
            [5, { name: 'vf', desc: 'Intelliflo VF', minFlow: 15, maxFlow: 130, maxCircuits: 8, hasAddress: true }],
            [100, { name: 'sf', desc: 'SuperFlo VS', hasAddress: false, maxCircuits: 8, maxRelays: 4, equipmentMaster: 1 }]
        ]);
        // RSG - same as systemBoard definition; can delete.
        this.valueMaps.heatModes = new byteValueMap([
            [0, { name: 'off', desc: 'Off' }],
            [3, { name: 'heater', desc: 'Heater' }],
            [5, { name: 'solar', desc: 'Solar Only' }],
            [12, { name: 'solarpref', desc: 'Solar Preferred' }]
        ]);
        this.valueMaps.scheduleDays = new byteValueMap([
            [1, { name: 'mon', desc: 'Monday', dow: 1, bitval: 1 }],
            [2, { name: 'tue', desc: 'Tuesday', dow: 2, bitval: 2 }],
            [3, { name: 'wed', desc: 'Wednesday', dow: 3, bitval: 4 }],
            [4, { name: 'thu', desc: 'Thursday', dow: 4, bitval: 8 }],
            [5, { name: 'fri', desc: 'Friday', dow: 5, bitval: 16 }],
            [6, { name: 'sat', desc: 'Saturday', dow: 6, bitval: 32 }],
            [7, { name: 'sun', desc: 'Sunday', dow: 0, bitval: 64 }]
        ]);
        this.valueMaps.groupCircuitStates = new byteValueMap([
            [1, { name: 'on', desc: 'On' }],
            [2, { name: 'off', desc: 'Off' }],
            [3, { name: 'ignore', desc: 'Ignore' }]
        ]);

        // Keep this around for now so I can fart with the custom names array.
        //this.valueMaps.customNames = new byteValueMap(
        //    sys.customNames.get().map((el, idx) => {
        //        return [idx + 200, { name: el.name, desc: el.name }];
        //    })
        //);
        this.valueMaps.scheduleDays.toArray = function () {
            let arrKeys = Array.from(this.keys());
            let arr = [];
            for (let i = 0; i < arrKeys.length; i++) arr.push(extend(true, { val: arrKeys[i] }, this.get(arrKeys[i])));
            return arr;
        }
        this.valueMaps.scheduleDays.transform = function (byte) {
            let days = [];
            let b = byte & 0x007F;
            for (let bit = 6; bit >= 0; bit--) {
                if ((byte & (1 << bit)) > 0) days.push(extend(true, {}, this.get(bit + 1)));
            }
            return { val: b, days: days };
        };
        this.valueMaps.expansionBoards = new byteValueMap([
            [0, { name: 'nxp', part: 'NXP', desc: 'Nixie Single Body', bodies: 1, valves: 0, shared: false, dual: false }],
            [1, { name: 'nxps', part: 'NXPS', desc: 'Nixie Shared Body', bodies: 2, valves: 2, shared: true, dual: false, chlorinators: 1, chemControllers: 1 }],
            [2, { name: 'nxpd', part: 'NXPD', desc: 'Nixie Dual Body', bodies: 2, valves: 0, shared: false, dual: true, chlorinators: 2, chemControllers: 2 }],
            [255, { name: 'nxnb', part: 'NXNB', desc: 'Nixie No Body', bodies: 0, valves: 0, shared: false, dual: false, chlorinators: 0, chemControllers: 0 }]
        ]);
        this.valueMaps.virtualCircuits = new byteValueMap([
            [237, { name: 'heatBoost', desc: 'Heat Boost' }],
            [238, { name: 'heatEnable', desc: 'Heat Enable' }],
            [239, { name: 'pumpSpeedUp', desc: 'Pump Speed +' }],
            [240, { name: 'pumpSpeedDown', desc: 'Pump Speed -' }],
            [244, { name: 'poolHeater', desc: 'Pool Heater' }],
            [245, { name: 'spaHeater', desc: 'Spa Heater' }],
            [246, { name: 'freeze', desc: 'Freeze' }],
            [247, { name: 'poolSpa', desc: 'Pool/Spa' }],
            [248, { name: 'solarHeat', desc: 'Solar Heat' }],
            [251, { name: 'heater', desc: 'Heater' }],
            [252, { name: 'solar', desc: 'Solar' }],
            [255, { name: 'poolHeatEnable', desc: 'Pool Heat Enable' }]
        ]);
        this.valueMaps.scheduleTimeTypes.merge([
            [1, { name: 'sunrise', desc: 'Sunrise' }],
            [2, { name: 'sunset', desc: 'Sunset' }]
        ]);
        this.valueMaps.lightThemes = new byteValueMap([
            [0, { name: 'white', desc: 'White' }],
            [1, { name: 'green', desc: 'Green' }],
            [2, { name: 'blue', desc: 'Blue' }],
            [3, { name: 'magenta', desc: 'Magenta' }],
            [4, { name: 'red', desc: 'Red' }],
            [5, { name: 'sam', desc: 'SAm Mode' }],
            [6, { name: 'party', desc: 'Party' }],
            [7, { name: 'romance', desc: 'Romance' }],
            [8, { name: 'caribbean', desc: 'Caribbean' }],
            [9, { name: 'american', desc: 'American' }],
            [10, { name: 'sunset', desc: 'Sunset' }],
            [11, { name: 'royal', desc: 'Royal' }],
            [255, { name: 'none', desc: 'None' }]
        ]);
        this.valueMaps.lightColors = new byteValueMap([
            [0, { name: 'white', desc: 'White' }],
            [16, { name: 'lightgreen', desc: 'Light Green' }],
            [32, { name: 'green', desc: 'Green' }],
            [48, { name: 'cyan', desc: 'Cyan' }],
            [64, { name: 'blue', desc: 'Blue' }],
            [80, { name: 'lavender', desc: 'Lavender' }],
            [96, { name: 'magenta', desc: 'Magenta' }],
            [112, { name: 'lightmagenta', desc: 'Light Magenta' }]
        ]);
        this.valueMaps.heatSources = new byteValueMap([
            [0, { name: 'off', desc: 'No Heater' }],
            [3, { name: 'heater', desc: 'Heater' }],
            [5, { name: 'solar', desc: 'Solar Only' }],
            [21, { name: 'solarpref', desc: 'Solar Preferred' }],
            [32, { name: 'nochange', desc: 'No Change' }]
        ]);
        this.valueMaps.heatStatus = new byteValueMap([
            [0, { name: 'off', desc: 'Off' }],
            [1, { name: 'heater', desc: 'Heater' }],
            [2, { name: 'solar', desc: 'Solar' }],
            [3, { name: 'cooling', desc: 'Cooling' }]
        ]);
        this.valueMaps.scheduleTypes = new byteValueMap([
            [0, { name: 'runonce', desc: 'Run Once', startDate: true, startTime: true, endTime: true, days: false, heatSource: true, heatSetpoint: true }],
            [128, { name: 'repeat', desc: 'Repeats', startDate: false, startTime: true, endTime: true, days: 'multi', heatSource: true, heatSetpoint: true }]
        ]);
        this.valueMaps.remoteTypes = new byteValueMap([
            [0, { name: 'none', desc: 'Not Installed', maxButtons: 0 }],
            [1, { name: 'is4', desc: 'iS4 Spa-Side Remote', maxButtons: 4 }],
            [2, { name: 'is10', desc: 'iS10 Spa-Side Remote', maxButtons: 10 }],
            [3, { name: 'quickTouch', desc: 'Quick Touch Remote', maxButtons: 4 }],
            [4, { name: 'spaCommand', desc: 'Spa Command', maxButtons: 10 }]
        ]);
    }
    public async initNixieBoard() {
        try {
            this.killStatusCheck();
            sys.general.options.clockSource = 'server';
            state.status = sys.board.valueMaps.controllerStatus.transform(0, 0);
            // First lets clear out all the messages.
            state.equipment.messages.removeItemByCode('EQ')
            // Set up all the default information for the controller.  This should be done
            // for the startup of the system.  The equipment installed at module 0 is the main
            // system descriptor.
            let mod = sys.equipment.modules.getItemById(0, true);
            mod.master = 1;
            //[0, { name: 'nxp', part: 'NXP', desc: 'Nixie Single Body', bodies: 1, valves: 2, shared: false, dual: false }],
            //[1, { name: 'nxps', part: 'NXPS', desc: 'Nixie Shared Body', bodies: 2, valves: 4, shared: true, dual: false, chlorinators: 1, chemControllers: 1 }],
            //[2, { name: 'nxpd', part: 'NXPD', desc: 'Nixe Dual Body', bodies: 2, valves: 2, shared: false, dual: true, chlorinators: 2, chemControllers: 2 }],
            //[255, { name: 'nxu', part: 'Unspecified', desc: 'Nixie No Body', bodies: 0, valves: 0, shared: false, dual: false, chlorinators: 0, chemControllers: 0 }]
            let type = typeof mod.type !== 'undefined' ? this.valueMaps.expansionBoards.transform(mod.type) : this.valueMaps.expansionBoards.transform(0);
            logger.info(`Initializing Nixie Control Panel for ${type.desc}`);

            sys.equipment.shared = type.shared;
            sys.equipment.dual = type.dual;
            sys.equipment.controllerFirmware = '1.0.0';
            mod.type = type.val;
            mod.part = type.part;
            let md = mod.get();
            md['bodies'] = type.bodies;
            md['part'] = type.part;
            md['valves'] = type.valves;
            mod.name = type.name;
            sys.equipment.model = mod.desc = type.desc;
            state.equipment.maxValves = sys.equipment.maxValves = 32;
            state.equipment.maxCircuits = sys.equipment.maxCircuits = 40;
            state.equipment.maxFeatures = sys.equipment.maxFeatures = 32;
            state.equipment.maxHeaters = sys.equipment.maxHeaters = 16;
            state.equipment.maxLightGroups = sys.equipment.maxLightGroups = 16;
            state.equipment.maxCircuitGroups = sys.equipment.maxCircuitGroups = 16;
            state.equipment.maxSchedules = sys.equipment.maxSchedules = 100;
            state.equipment.maxPumps = sys.equipment.maxPumps = 16;
            state.equipment.controllerType = sys.controllerType;
            sys.equipment.maxCustomNames = 0;
            state.equipment.model = type.desc;
            state.equipment.maxBodies = sys.equipment.maxBodies = type.bodies;
            
            if (typeof state.temps.units === 'undefined' || state.temps.units < 0) state.temps.units = sys.general.options.units;
            if (type.bodies > 0) {
                let pool = sys.bodies.getItemById(1, true);
                let sbody = state.temps.bodies.getItemById(1, true);
                if (typeof pool.type === 'undefined') pool.type = 0;
                if (typeof pool.name === 'undefined') pool.name = type.dual ? 'Body 1' : 'Pool';
                if (typeof pool.capacity === 'undefined') pool.capacity = 0;
                if (typeof pool.setPoint === 'undefined') pool.setPoint = 0;
                pool.circuit = 6;
                pool.isActive = true;
                pool.master = 1;
                sbody.name = pool.name;
                sbody.setPoint = pool.setPoint;
                sbody.circuit = pool.circuit;
                sbody.type = pool.type;
                // We need to add in a circuit for 6.
                let circ = sys.circuits.getItemById(6, true, { name: pool.name, showInFeatures: false });
                let scirc = state.circuits.getItemById(6, true);
                //[12, { name: 'pool', desc: 'Pool', hasHeatSource: true }],
                //[13, { name: 'spa', desc: 'Spa', hasHeatSource: true }]
                circ.type = 12;
                if (typeof circ.showInFeatures === 'undefined') circ.showInFeatures = false;
                circ.isActive = true;
                circ.master = 1;
                scirc.showInFeatures = circ.showInFeatures;
                scirc.type = circ.type;
                scirc.name = circ.name;
                if (type.shared || type.dual) {
                    // We are going to add two bodies and prune off the othergood ls.
                    let spa = sys.bodies.getItemById(2, true);
                    if (typeof spa.type === 'undefined') spa.type = type.dual ? 0 : 1;
                    if (typeof spa.name === 'undefined') spa.name = type.dual ? 'Body 2' : 'Spa';
                    if (typeof spa.capacity === 'undefined') spa.capacity = 0;
                    if (typeof spa.setPoint === 'undefined') spa.setPoint = 0;
                    circ = sys.circuits.getItemById(1, true, {name: spa.name, showInFeatures: false });
                    circ.type = type.dual ? 12 : 13;
                    circ.isActive = true;
                    circ.master = 1;
                    spa.circuit = 1;
                    spa.isActive = true;
                    spa.master = 1;
                    sbody = state.temps.bodies.getItemById(2, true);
                    sbody.name = spa.name;
                    sbody.setPoint = spa.setPoint;
                    sbody.circuit = spa.circuit;
                    sbody.type = spa.type;
                    scirc = state.circuits.getItemById(1, true);
                    scirc.showInFeatures = circ.showInFeatures;
                    scirc.type = circ.type;
                    scirc.name = circ.name;
                }
                else {
                    // Remove the items that are not part of our board.
                    sys.bodies.removeItemById(2);
                    state.temps.bodies.removeItemById(2);
                    sys.circuits.removeItemById(1);
                    state.circuits.removeItemById(1);
                }
            }
            else {
                sys.bodies.removeItemById(1);
                sys.bodies.removeItemById(2);
                state.temps.bodies.removeItemById(1);
                state.temps.bodies.removeItemById(2);
                sys.circuits.removeItemById(1);
                state.circuits.removeItemById(1);
                sys.circuits.removeItemById(6);
                state.circuits.removeItemById(6);
            }
            sys.equipment.setEquipmentIds();
            sys.board.bodies.initFilters();
            state.status = sys.board.valueMaps.controllerStatus.transform(2, 0);
            // Add up all the stuff we need to initialize.
            let total = sys.bodies.length;
            total += sys.circuits.length;
            total += sys.heaters.length;
            total += sys.chlorinators.length;
            total += sys.chemControllers.length;
            total += sys.filters.length;
            total += sys.pumps.length;
            total += sys.valves.length;
            this.initValves();
            await this.verifySetup();
            await ncp.initAsync(sys);
            sys.board.heaters.updateHeaterServices();
            state.cleanupState();
            logger.info(`${sys.equipment.model} control board initialized`);
            state.status = sys.board.valueMaps.controllerStatus.transform(1, 100);
            // At this point we should have the start of a board so lets check to see if we are ready or if we are stuck initializing.
            setTimeout(() => this.processStatusAsync(), 5000);
        } catch (err) { state.status = 255; logger.error(`Error Initializing Nixie Control Panel ${err.message}`); }
    }
    public initValves() {
        logger.info(`Initializing Intake/Return valves`);
        let iv = sys.valves.find(elem => elem.isIntake === true);
        let rv = sys.valves.find(elem => elem.isReturn === true);
        if (sys.equipment.shared) {
            if (typeof iv === 'undefined') iv = sys.valves.getItemById(sys.valves.getMaxId(false, 0) + 1, true);
            iv.isIntake = true;
            iv.isReturn = false;
            iv.type = 0;
            iv.name = 'Intake';
            iv.circuit = 247;
            iv.isActive = true;
            iv.master = 1;
            if (typeof rv === 'undefined') rv = sys.valves.getItemById(sys.valves.getMaxId(false, 0) + 1, true);
            rv.isIntake = false;
            rv.isReturn = true;
            rv.name = 'Return';
            rv.type = 0;
            rv.circuit = 247;
            rv.isActive = true;
            rv.master = 1;

        }
        else {
            if (typeof iv !== 'undefined') {
                sys.valves.removeItemById(iv.id);
                state.valves.removeItemById(iv.id);
            }
            if (typeof rv !== 'undefined') {
                sys.valves.removeItemById(rv.id);
                state.valves.removeItemById(rv.id);
            }
        }
    }
    public async verifySetup() {
        try {
            // In here we are going to attempt to check all the nixie relays.  We will not check the other equipment just the items
            // that make up a raw pool like the circuits.  The other stuff is the stuff of the equipment control.
            let circs = sys.circuits.toArray().filter((val) => { return val.controller === 1; });
            for (let i = 0; i < circs.length; i++) {
                let circ = circs[i];
                // Make sure we have a circuit identified in the ncp if it is controlled by Nixie.
                let c = await ncp.circuits.initCircuitAsync(circ);
                // Now we should have the circuit from nixie so check the status to see if it can be
                // controlled. i.e. The comms are up.
                await c.validateSetupAsync(circ, state.circuits.getItemById(circ.id))
            }
            // Now we need to validate the heaters.  Some heaters will be connected via a relay.  If they have comms we will check it.
            let heaters = sys.heaters.toArray().filter((val) => { return val.controller === 1 });
            for (let i = 0; i < heaters.length; i++) {
                let heater = heaters[i];
                let h = await ncp.heaters.initHeaterAsync(heater);
            }
            // If we have relay based pumps, init them here... ss, ds, superflo
            let pumps = sys.heaters.toArray().filter((val) => { return val.controller === 1 });
            for (let i = 0; i < pumps.length; i++) {
                let pump = pumps[i];
                if (pump.type === 65){ // how are we defining ss and superflo?
                    await ncp.pumps.initPumpAsync(pump);
                }
            }
        } catch (err) { logger.error(`Error verifying setup`); }
    }
    public equipmentMaster = 1;
    public system: NixieSystemCommands = new NixieSystemCommands(this);
    public circuits: NixieCircuitCommands = new NixieCircuitCommands(this);
    public features: NixieFeatureCommands = new NixieFeatureCommands(this);
    //public chlorinator: NixieChlorinatorCommands = new NixieChlorinatorCommands(this);
    public bodies: NixieBodyCommands = new NixieBodyCommands(this);
    public filters: NixieFilterCommands = new NixieFilterCommands(this);
    //public pumps: NixiePumpCommands = new NixiePumpCommands(this);
    //public schedules: NixieScheduleCommands = new NixieScheduleCommands(this);
    public heaters: NixieHeaterCommands = new NixieHeaterCommands(this);
    public valves: NixieValveCommands = new NixieValveCommands(this);
    public chemControllers: NixieChemControllerCommands = new NixieChemControllerCommands(this);
    public async setControllerType(obj): Promise<Equipment> {
        try {
            if (typeof obj.model === 'undefined') return Promise.reject(new InvalidEquipmentDataError(`Nixie: Controller model not supplied`, 'model', obj.model));
            let mt = this.valueMaps.expansionBoards.findItem(obj.model);
            if (typeof mt === 'undefined') return Promise.reject(new InvalidEquipmentDataError(`Nixie: A valid Controller model not supplied ${obj.model}`, 'model', obj.model));
            this.killStatusCheck();
            let mod = sys.equipment.modules.getItemById(0, true);
            mod.type = mt.val;
            await this.initNixieBoard();
            state.emitControllerChange();
            return sys.equipment;
        } catch (err) { logger.error(`Error setting Nixie controller type.`); }
    }
}
export class NixieBodyCommands extends BodyCommands {

}
export class NixieFilterCommands extends FilterCommands {
    public async setFilterStateAsync(filter: Filter, fstate: FilterState, isOn: boolean) {
        try {
            await ncp.filters.setFilterStateAsync(fstate, isOn);
        }
        catch (err) { return Promise.reject(`Nixie: Error setFiterStateAsync ${err.message}`); }
    }
}

export class NixieSystemCommands extends SystemCommands {
    public cancelDelay(): Promise<any> { state.delay = sys.board.valueMaps.delay.getValue('nodelay'); return Promise.resolve(state.data.delay); }
    public setDateTimeAsync(obj: any): Promise<any> { return Promise.resolve(); }
    public getDOW() { return this.board.valueMaps.scheduleDays.toArray(); }
    public async setGeneralAsync(obj: any): Promise<General> {
        let general = sys.general.get();
        if (typeof obj.alias === 'string') sys.general.alias = obj.alias;
        if (typeof obj.options !== 'undefined') await sys.board.system.setOptionsAsync(obj.options);
        if (typeof obj.location !== 'undefined') await sys.board.system.setLocationAsync(obj.location);
        if (typeof obj.owner !== 'undefined') await sys.board.system.setOwnerAsync(obj.owner);
        return new Promise<General>(function (resolve, reject) { resolve(sys.general); });
    }
    public async setModelAsync(obj: any) {
        try {
            // First things first.

        } catch (err) { return logger.error(`Error setting Nixie Model: ${err.message}`); }
    }
}
export class NixieCircuitCommands extends CircuitCommands {
    public async setCircuitStateAsync(id: number, val: boolean): Promise<ICircuitState> {
        sys.board.suspendStatus(true);
        try {
            // We need to do some routing here as it is now critical that circuits, groups, and features
            // have their own processing.  The virtual controller used to only deal with one circuit.
            if (sys.board.equipmentIds.circuitGroups.isInRange(id))
                return await sys.board.circuits.setCircuitGroupStateAsync(id, val);
            else if (sys.board.equipmentIds.features.isInRange(id))
                return await sys.board.features.setFeatureStateAsync(id, val);

            let circuit: ICircuit = sys.circuits.getInterfaceById(id, false, { isActive: false });
            if (isNaN(id)) return Promise.reject(new InvalidEquipmentIdError(`Circuit or Feature id ${id} not valid`, id, 'Circuit'));
            let circ = state.circuits.getInterfaceById(id, circuit.isActive !== false);
            let newState = utils.makeBool(val);
            // First, if we are turning the circuit on, lets determine whether the circuit is a pool or spa circuit and if this is a shared system then we need
            // to turn off the other body first.
            //[12, { name: 'pool', desc: 'Pool', hasHeatSource: true }],
            //[13, { name: 'spa', desc: 'Spa', hasHeatSource: true }]
            if (newState && (circuit.type === 12 || circuit.type === 13)) {
                if (sys.equipment.shared === true) {
                    // If we are shared we need to turn off the other circuit.
                    let offType = circ.type === 12 ? 13 : 12;
                    let off = sys.circuits.get().filter(elem => elem.type === offType);
                    // Turn the circuits off that are part of the shared system.  We are going back to the board
                    // just in case we got here for a circuit that isn't on the current defined panel.
                    for (let i = 0; i < off.length; i++) {
                        let coff = off[i];
                        logger.info(`Turning off shared body ${coff.name} circuit`);
                        await sys.board.circuits.setCircuitStateAsync(coff.id, false);
                    }
                }
                //sys.board.virtualChlorinatorController.start();
            }
            if (id === 6) state.temps.bodies.getItemById(1, true).isOn = val;
            else if (id === 1) state.temps.bodies.getItemById(2, true).isOn = val;
            // Let the main nixie controller set the circuit state and affect the relays if it needs to.
            await ncp.circuits.setCircuitStateAsync(circ, newState);
            return state.circuits.getInterfaceById(circ.id);
        }
        catch (err) { return Promise.reject(`Nixie: Error setCircuitStateAsync ${err.message}`); }
        finally {
            state.emitEquipmentChanges();
            // sys.board.virtualPumpControllers.start();
            ncp.pumps.syncPumpStates();
            sys.board.suspendStatus(false);
            this.board.processStatusAsync();
        }
    }
    public toggleCircuitStateAsync(id: number): Promise<ICircuitState> {
        let circ = state.circuits.getInterfaceById(id);
        return this.setCircuitStateAsync(id, !(circ.isOn || false));
    }
    public async setLightThemeAsync(id: number, theme: number) {
        let cstate = state.circuits.getItemById(id);
        cstate.lightingTheme = theme;
        return Promise.resolve(cstate as ICircuitState);
    }
    public setDimmerLevelAsync(id: number, level: number): Promise<ICircuitState> {
        let circ = state.circuits.getItemById(id);
        circ.level = level;
        return Promise.resolve(circ as ICircuitState);
    }
    public getCircuitReferences(includeCircuits?: boolean, includeFeatures?: boolean, includeVirtual?: boolean, includeGroups?: boolean) {
        let arrRefs = [];
        if (includeCircuits) {
            // RSG: converted this to getItemByIndex because hasHeatSource isn't actually stored as part of the data
            for (let i = 0; i < sys.circuits.length; i++) {
                let c = sys.circuits.getItemByIndex(i);
                arrRefs.push({ id: c.id, name: c.name, type: c.type, equipmentType: 'circuit', nameId: c.nameId, hasHeatSource: c.hasHeatSource });
            }
        }
        if (includeFeatures) {
            let features = sys.features.get();
            for (let i = 0; i < sys.features.length; i++) {
                let c = features[i];
                arrRefs.push({ id: c.id, name: c.name, type: c.type, equipmentType: 'feature', nameId: c.nameId });
            }
        }
        if (includeVirtual) {
            let vcs = sys.board.valueMaps.virtualCircuits.toArray();
            for (let i = 0; i < vcs.length; i++) {
                let c = vcs[i];
                arrRefs.push({ id: c.val, name: c.desc, equipmentType: 'virtual', assignableToPumpCircuit: c.assignableToPumpCircuit });
            }
        }
        if (includeGroups) {
            let groups = sys.circuitGroups.get();
            for (let i = 0; i < groups.length; i++) {
                let c = groups[i];
                arrRefs.push({ id: c.id, name: c.name, equipmentType: 'circuitGroup', nameId: c.nameId });
            }
            groups = sys.lightGroups.get();
            for (let i = 0; i < groups.length; i++) {
                let c = groups[i];
                arrRefs.push({ id: c.id, name: c.name, equipmentType: 'lightGroup', nameId: c.nameId });
            }
        }
        arrRefs.sort((a, b) => { return a.id > b.id ? 1 : a.id === b.id ? 0 : -1; });
        return arrRefs;
    }
    public getLightReferences() {
        let circuits = sys.circuits.get();
        let arrRefs = [];
        for (let i = 0; i < circuits.length; i++) {
            let c = circuits[i];
            let type = sys.board.valueMaps.circuitFunctions.transform(c.type);
            if (type.isLight) arrRefs.push({ id: c.id, name: c.name, type: c.type, equipmentType: 'circuit', nameId: c.nameId });
        }
        return arrRefs;
    }
    public getLightThemes(type?: number) { return sys.board.valueMaps.lightThemes.toArray(); }
    public getCircuitFunctions() { return sys.board.valueMaps.circuitFunctions.toArray(); }
    public getCircuitNames() {
        return [...sys.board.valueMaps.circuitNames.toArray(), ...sys.board.valueMaps.customNames.toArray()];
    }
    public async setCircuitAsync(data: any): Promise<ICircuit> {
        try {
            let id = parseInt(data.id, 10);
            if (id <= 0 || isNaN(id)) {
                // You can add any circuit so long as it isn't 1 or 6.
                id = sys.circuits.getNextEquipmentId(sys.board.equipmentIds.circuits, [1, 6]);
            }
            if (isNaN(id) || !sys.board.equipmentIds.circuits.isInRange(id)) return Promise.reject(new InvalidEquipmentIdError(`Invalid circuit id: ${data.id}`, data.id, 'Circuit'));
            let circuit = sys.circuits.getItemById(id, true);
            let scircuit = state.circuits.getItemById(id, true);
            circuit.isActive = true;
            scircuit.isOn = false;
            if (data.name) circuit.name = scircuit.name = data.name;
            else if (!circuit.name && !data.name) circuit.name = scircuit.name = Circuit.getIdName(id);
            if (typeof data.type !== 'undefined' || typeof circuit.type === 'undefined') circuit.type = scircuit.type = parseInt(data.type, 10) || 0;
            if (typeof data.freeze !== 'undefined' || typeof circuit.freeze === 'undefined') circuit.freeze = utils.makeBool(data.freeze) || false;
            if (typeof data.showInFeatures !== 'undefined' || typeof data.showInFeatures === 'undefined') circuit.showInFeatures = scircuit.showInFeatures = utils.makeBool(data.showInFeatures);
            if (typeof data.dontStop !== 'undefined' && utils.makeBool(data.dontStop) === true) data.eggTimer = 1440;
            if (typeof data.eggTimer !== 'undefined' || typeof circuit.eggTimer === 'undefined') circuit.eggTimer = parseInt(data.eggTimer, 10) || 0;
            if (typeof data.connectionId !== 'undefined') circuit.connectionId = data.connectionId;
            if (typeof data.deviceBinding !== 'undefined') circuit.deviceBinding = data.deviceBinding;
            circuit.dontStop = circuit.eggTimer === 1440;
            sys.emitEquipmentChange();
            state.emitEquipmentChanges();
            ncp.circuits.setCircuitAsync(circuit, data);
            return circuit;
        } catch (err) { logger.error(`Error setting circuit data ${err.message}`); }
    }
    public async setCircuitGroupAsync(obj: any): Promise<CircuitGroup> {
        let group: CircuitGroup = null;
        let id = typeof obj.id !== 'undefined' ? parseInt(obj.id, 10) : -1;
        if (id <= 0) {
            // We are adding a circuit group.
            id = sys.circuitGroups.getNextEquipmentId(sys.board.equipmentIds.circuitGroups);
        }
        if (typeof id === 'undefined') return Promise.reject(new InvalidEquipmentIdError(`Max circuit group id exceeded`, id, 'CircuitGroup'));
        if (isNaN(id) || !sys.board.equipmentIds.circuitGroups.isInRange(id)) return Promise.reject(new InvalidEquipmentIdError(`Invalid circuit group id: ${obj.id}`, obj.id, 'CircuitGroup'));
        group = sys.circuitGroups.getItemById(id, true);
        return new Promise<CircuitGroup>((resolve, reject) => {
            if (typeof obj.name !== 'undefined') group.name = obj.name;
            if (typeof obj.dontStop !== 'undefined' && utils.makeBool(obj.dontStop) === true) obj.eggTimer = 1440;
            if (typeof obj.eggTimer !== 'undefined') group.eggTimer = Math.min(Math.max(parseInt(obj.eggTimer, 10), 0), 1440);
            group.dontStop = group.eggTimer === 1440;
            group.isActive = true;

            if (typeof obj.circuits !== 'undefined') {
                for (let i = 0; i < obj.circuits.length; i++) {
                    let c = group.circuits.getItemByIndex(i, true, { id: i + 1 });
                    let cobj = obj.circuits[i];
                    if (typeof cobj.circuit !== 'undefined') c.circuit = cobj.circuit;
                    if (typeof cobj.desiredState !== 'undefined')
                        c.desiredState = parseInt(cobj.desiredState, 10);
                    else if (typeof cobj.desiredStateOn !== 'undefined') {
                        // Shim for prior interfaces that send desiredStateOn.
                        c.desiredState = utils.makeBool(cobj.desiredStateOn) ? 0 : 1;
                        //c.desiredStateOn = utils.makeBool(cobj.desiredStateOn);
                    }
                    //RKS: 09-26-20 There is no such thing as a lighting theme on a circuit group circuit.  That is what lighGroups are for.
                    //if (typeof cobj.lightingTheme !== 'undefined') c.lightingTheme = parseInt(cobj.lightingTheme, 10);
                }
                // group.circuits.length = obj.circuits.length;  // RSG - removed as this will delete circuits that were not changed
            }
            resolve(group);
        });

    }
    public async setLightGroupAsync(obj: any): Promise<LightGroup> {
        let group: LightGroup = null;
        let id = typeof obj.id !== 'undefined' ? parseInt(obj.id, 10) : -1;
        if (id <= 0) {
            // We are adding a circuit group.
            id = sys.circuitGroups.getNextEquipmentId(sys.board.equipmentIds.circuitGroups);
        }
        if (typeof id === 'undefined') return Promise.reject(new InvalidEquipmentIdError(`Max circuit light group id exceeded`, id, 'LightGroup'));
        if (isNaN(id) || !sys.board.equipmentIds.circuitGroups.isInRange(id)) return Promise.reject(new InvalidEquipmentIdError(`Invalid circuit group id: ${obj.id}`, obj.id, 'LightGroup'));
        group = sys.lightGroups.getItemById(id, true);
        return new Promise<LightGroup>((resolve, reject) => {
            if (typeof obj.name !== 'undefined') group.name = obj.name;
            if (typeof obj.dontStop !== 'undefined' && utils.makeBool(obj.dontStop) === true) obj.eggTimer = 1440;
            if (typeof obj.eggTimer !== 'undefined') group.eggTimer = Math.min(Math.max(parseInt(obj.eggTimer, 10), 0), 1440);
            group.dontStop = group.eggTimer === 1440;
            group.isActive = true;
            if (typeof obj.circuits !== 'undefined') {
                for (let i = 0; i < obj.circuits.length; i++) {
                    let cobj = obj.circuits[i];
                    let c: LightGroupCircuit;
                    if (typeof cobj.id !== 'undefined') c = group.circuits.getItemById(parseInt(cobj.id, 10), true);
                    else if (typeof cobj.circuit !== 'undefined') c = group.circuits.getItemByCircuitId(parseInt(cobj.circuit, 10), true);
                    else c = group.circuits.getItemByIndex(i, true, { id: i + 1 });
                    if (typeof cobj.circuit !== 'undefined') c.circuit = cobj.circuit;
                    if (typeof cobj.lightingTheme !== 'undefined') c.lightingTheme = parseInt(cobj.lightingTheme, 10);
                    if (typeof cobj.color !== 'undefined') c.color = parseInt(cobj.color, 10);
                    if (typeof cobj.swimDelay !== 'undefined') c.swimDelay = parseInt(cobj.swimDelay, 10);
                    if (typeof cobj.position !== 'undefined') c.position = parseInt(cobj.position, 10);
                }
                // group.circuits.length = obj.circuits.length; // RSG - removed as this will delete circuits that were not changed
            }
            resolve(group);
        });
    }
    public async deleteCircuitGroupAsync(obj: any): Promise<CircuitGroup> {
        let id = parseInt(obj.id, 10);
        if (isNaN(id)) return Promise.reject(new EquipmentNotFoundError(`Invalid group id: ${obj.id}`, 'CircuitGroup'));
        if (!sys.board.equipmentIds.circuitGroups.isInRange(id)) return;
        if (typeof obj.id !== 'undefined') {
            let group = sys.circuitGroups.getItemById(id, false);
            let sgroup = state.circuitGroups.getItemById(id, false);
            sys.circuitGroups.removeItemById(id);
            state.circuitGroups.removeItemById(id);
            group.isActive = false;
            sgroup.isOn = false;
            sgroup.isActive = false;
            sgroup.emitEquipmentChange();
            return new Promise<CircuitGroup>((resolve, reject) => { resolve(group); });
        }
        else
            return Promise.reject(new InvalidEquipmentIdError('Group id has not been defined', id, 'CircuitGroup'));
    }
    public async deleteLightGroupAsync(obj: any): Promise<LightGroup> {
        let id = parseInt(obj.id, 10);
        if (isNaN(id)) return Promise.reject(new EquipmentNotFoundError(`Invalid group id: ${obj.id}`, 'LightGroup'));
        if (!sys.board.equipmentIds.circuitGroups.isInRange(id)) return;
        if (typeof obj.id !== 'undefined') {
            let group = sys.lightGroups.getItemById(id, false);
            let sgroup = state.lightGroups.getItemById(id, false);
            sys.lightGroups.removeItemById(id);
            state.lightGroups.removeItemById(id);
            group.isActive = false;
            sgroup.isOn = false;
            sgroup.isActive = false;
            sgroup.emitEquipmentChange();
            return new Promise<LightGroup>((resolve, reject) => { resolve(group); });
        }
        else
            return Promise.reject(new InvalidEquipmentIdError('Group id has not been defined', id, 'LightGroup'));
    }
    public async deleteCircuitAsync(data: any): Promise<ICircuit> {
        if (typeof data.id === 'undefined') return Promise.reject(new InvalidEquipmentIdError('You must provide an id to delete a circuit', data.id, 'Circuit'));
        let circuit = sys.circuits.getInterfaceById(data.id);
        if (circuit instanceof Circuit) {
            sys.circuits.removeItemById(data.id);
            state.circuits.removeItemById(data.id);
        }
        if (circuit instanceof Feature) {
            sys.features.removeItemById(data.id);
            state.features.removeItemById(data.id);
        }
        return new Promise<ICircuit>((resolve, reject) => { resolve(circuit); });
    }
    public deleteCircuit(data: any) {
        if (typeof data.id !== 'undefined') {
            let circuit = sys.circuits.getInterfaceById(data.id);
            if (circuit instanceof Circuit) {
                sys.circuits.removeItemById(data.id);
                state.circuits.removeItemById(data.id);
                return;
            }
            if (circuit instanceof Feature) {
                sys.features.removeItemById(data.id);
                state.features.removeItemById(data.id);
                return;
            }
        }
    }
    public getNameById(id: number) {
        if (id < 200)
            return sys.board.valueMaps.circuitNames.transform(id).desc;
        else
            return sys.customNames.getItemById(id - 200).name;
    }
    public async setLightGroupThemeAsync(id: number, theme: number): Promise<ICircuitState> {
        const grp = sys.lightGroups.getItemById(id);
        const sgrp = state.lightGroups.getItemById(id);
        grp.lightingTheme = sgrp.lightingTheme = theme;
        for (let i = 0; i < grp.circuits.length; i++) {
            let c = grp.circuits.getItemByIndex(i);
            let cstate = state.circuits.getItemById(c.circuit);
            // if theme is 'off' light groups should not turn on
            if (cstate.isOn && sys.board.valueMaps.lightThemes.getName(theme) === 'off')
                await sys.board.circuits.setCircuitStateAsync(c.circuit, false);
            else if (!cstate.isOn && sys.board.valueMaps.lightThemes.getName(theme) !== 'off') await sys.board.circuits.setCircuitStateAsync(c.circuit, true);
        }
        sgrp.isOn = sys.board.valueMaps.lightThemes.getName(theme) === 'off' ? false : true;
        // If we truly want to support themes in lightGroups we probably need to program
        // the specific on/off toggles to enable that.  For now this will go through the motions but it's just a pretender.
        switch (theme) {
            case 0: // off
            case 1: // on
                break;
            case 128: // sync
                setImmediate(function () { sys.board.circuits.sequenceLightGroupAsync(grp.id, 'sync'); });
                break;
            case 144: // swim
                setImmediate(function () { sys.board.circuits.sequenceLightGroupAsync(grp.id, 'swim'); });
                break;
            case 160: // swim
                setImmediate(function () { sys.board.circuits.sequenceLightGroupAsync(grp.id, 'set'); });
                break;
            case 190: // save
            case 191: // recall
                setImmediate(function () { sys.board.circuits.sequenceLightGroupAsync(grp.id, 'other'); });
                break;
            default:
                setImmediate(function () { sys.board.circuits.sequenceLightGroupAsync(grp.id, 'color'); });
            // other themes for magicstream?
        }
        sgrp.hasChanged = true; // Say we are dirty but we really are pure as the driven snow.
        state.emitEquipmentChanges();
        return Promise.resolve(sgrp);
    }
    public async setLightGroupAttribsAsync(group: LightGroup): Promise<LightGroup> {
        let grp = sys.lightGroups.getItemById(group.id);
        try {
            grp.circuits.clear();
            for (let i = 0; i < group.circuits.length; i++) {
                let circuit = grp.circuits.getItemByIndex(i);
                grp.circuits.add({ id: i, circuit: circuit.circuit, color: circuit.color, position: i, swimDelay: circuit.swimDelay });
            }
            let sgrp = state.lightGroups.getItemById(group.id);
            sgrp.hasChanged = true; // Say we are dirty but we really are pure as the driven snow.
            return Promise.resolve(grp);
        }
        catch (err) { return Promise.reject(err); }
    }
    public sequenceLightGroupAsync(id: number, operation: string): Promise<LightGroupState> {
        let sgroup = state.lightGroups.getItemById(id);
        let nop = sys.board.valueMaps.intellibriteActions.getValue(operation);
        if (nop > 0) {
            sgroup.action = nop;
            sgroup.hasChanged = true; // Say we are dirty but we really are pure as the driven snow.
            state.emitEquipmentChanges();
            setTimeout(function () {
                sgroup.action = 0;
                sgroup.hasChanged = true; // Say we are dirty but we really are pure as the driven snow.
                state.emitEquipmentChanges();
            }, 20000); // It takes 20 seconds to sequence.
        }
        return Promise.resolve(sgroup);
    }
    public async setCircuitGroupStateAsync(id: number, val: boolean): Promise<ICircuitGroupState> {
        let grp = sys.circuitGroups.getItemById(id, false, { isActive: false });
        let gstate = (grp.dataName === 'circuitGroupConfig') ? state.circuitGroups.getItemById(grp.id, grp.isActive !== false) : state.lightGroups.getItemById(grp.id, grp.isActive !== false);
        let circuits = grp.circuits.toArray();
        gstate.isOn = val;
        let arr = [];
        for (let i = 0; i < circuits.length; i++) {
            let circuit = circuits[i];
            arr.push(sys.board.circuits.setCircuitStateAsync(circuit.circuit, val));
        }
        return new Promise<ICircuitGroupState>(async (resolve, reject) => {
            await Promise.all(arr).catch((err) => { reject(err) });
            resolve(gstate);
        });
    }
    public async setLightGroupStateAsync(id: number, val: boolean): Promise<ICircuitGroupState> {
        return sys.board.circuits.setCircuitGroupStateAsync(id, val);
    }
    /*     public sequenceIntelliBrite(operation: string) {
            state.intellibrite.hasChanged = true;
            let nop = sys.board.valueMaps.intellibriteActions.getValue(operation);
            if (nop > 0) {
                state.intellibrite.action = nop;
                setTimeout(function() { state.intellibrite.action = 0; state.emitEquipmentChanges(); }, 20000); // It takes 20 seconds to sequence.
            }
        } */
}
export class NixieFeatureCommands extends FeatureCommands {
    public async setFeatureAsync(obj: any): Promise<Feature> {
        let id = parseInt(obj.id, 10);
        if (id <= 0 || isNaN(id)) {
            id = sys.features.getNextEquipmentId(sys.board.equipmentIds.features);
        }
        if (isNaN(id)) return Promise.reject(new InvalidEquipmentIdError(`Invalid feature id: ${obj.id}`, obj.id, 'Feature'));
        if (!sys.board.equipmentIds.features.isInRange(id)) return Promise.reject(new InvalidEquipmentIdError(`Feature id out of range: ${id}: ${sys.board.equipmentIds.features.start} to ${sys.board.equipmentIds.features.end}`, obj.id, 'Feature'));
        let feature = sys.features.getItemById(id, true);
        let sfeature = state.features.getItemById(id, true);
        feature.isActive = true;
        sfeature.isOn = false;
        if (obj.nameId) {
            feature.nameId = sfeature.nameId = obj.nameId;
            feature.name = sfeature.name = sys.board.valueMaps.circuitNames.get(obj.nameId);
        }
        else if (obj.name) feature.name = sfeature.name = obj.name;
        else if (!feature.name && !obj.name) feature.name = sfeature.name = `feature${obj.id}`;
        if (typeof obj.type !== 'undefined') feature.type = sfeature.type = parseInt(obj.type, 10);
        else if (!feature.type && typeof obj.type !== 'undefined') feature.type = sfeature.type = 0;
        if (typeof obj.freeze !== 'undefined') feature.freeze = utils.makeBool(obj.freeze);
        if (typeof obj.showInFeatures !== 'undefined') feature.showInFeatures = sfeature.showInFeatures = utils.makeBool(obj.showInFeatures);
        if (typeof obj.dontStop !== 'undefined' && utils.makeBool(obj.dontStop) === true) obj.eggTimer = 1440;
        if (typeof obj.eggTimer !== 'undefined') feature.eggTimer = parseInt(obj.eggTimer, 10);
        feature.dontStop = feature.eggTimer === 1440;
        return new Promise<Feature>((resolve, reject) => { resolve(feature); });
    }
    public async deleteFeatureAsync(obj: any): Promise<Feature> {
        let id = parseInt(obj.id, 10);
        if (isNaN(id)) return Promise.reject(new InvalidEquipmentIdError(`Invalid feature id: ${obj.id}`, obj.id, 'Feature'));
        if (!sys.board.equipmentIds.features.isInRange(id)) return Promise.reject(new InvalidEquipmentIdError(`Invalid feature id: ${obj.id}`, obj.id, 'Feature'));
        if (typeof obj.id !== 'undefined') {
            let feature = sys.features.getItemById(id, false);
            let sfeature = state.features.getItemById(id, false);
            sys.features.removeItemById(id);
            state.features.removeItemById(id);
            feature.isActive = false;
            sfeature.isOn = false;
            sfeature.showInFeatures = false;
            sfeature.emitEquipmentChange();
            return new Promise<Feature>((resolve, reject) => { resolve(feature); });
        }
        else
            Promise.reject(new InvalidEquipmentIdError('Feature id has not been defined', undefined, 'Feature'));
    }
    public async setFeatureStateAsync(id: number, val: boolean): Promise<ICircuitState> {
        try {
            if (isNaN(id)) return Promise.reject(new InvalidEquipmentIdError(`Invalid feature id: ${id}`, id, 'Feature'));
            if (!sys.board.equipmentIds.features.isInRange(id)) return Promise.reject(new InvalidEquipmentIdError(`Invalid feature id: ${id}`, id, 'Feature'));
            let feature = sys.features.getItemById(id);
            let fstate = state.features.getItemById(feature.id, feature.isActive !== false);
            fstate.isOn = val;
            sys.board.valves.syncValveStates();
            // sys.board.virtualPumpControllers.start();
            ncp.pumps.syncPumpStates();
            state.emitEquipmentChanges();
            return fstate;
        } catch (err) { return Promise.reject(new Error(`Error setting feature state ${err.message}`)); }
    }
    public async toggleFeatureStateAsync(id: number): Promise<ICircuitState> {
        let feat = state.features.getItemById(id);
        return this.setFeatureStateAsync(id, !(feat.isOn || false));
    }
    public syncGroupStates() {
        for (let i = 0; i < sys.circuitGroups.length; i++) {
            let grp: CircuitGroup = sys.circuitGroups.getItemByIndex(i);
            let circuits = grp.circuits.toArray();
            let bIsOn = false;
            if (grp.isActive) {
                for (let j = 0; j < circuits.length; j++) {
                    let circuit: CircuitGroupCircuit = grp.circuits.getItemById(j);
                    let cstate = state.circuits.getInterfaceById(circuit.circuit);
                    if (circuit.desiredState === 1 || circuit.desiredState === 0) {
                        if (cstate.isOn === utils.makeBool(circuit.desiredState)) bIsOn = true;
                    }
                }
            }
            let sgrp = state.circuitGroups.getItemById(grp.id);
            sgrp.isOn = bIsOn && grp.isActive;

            sys.board.valves.syncValveStates();
        }
        // I am guessing that there will only be one here but iterate
        // just in case we expand.
        for (let i = 0; i < sys.lightGroups.length; i++) {
            let grp: LightGroup = sys.lightGroups.getItemByIndex(i);
            let bIsOn = false;
            if (grp.isActive) {
                let circuits = grp.circuits.toArray();
                for (let j = 0; j < circuits.length; j++) {
                    let circuit = grp.circuits.getItemByIndex(j).circuit;
                    let cstate = state.circuits.getInterfaceById(circuit);
                    if (cstate.isOn) bIsOn = true;
                }
            }
            let sgrp = state.lightGroups.getItemById(grp.id);
            sgrp.isOn = bIsOn;
        }
        state.emitEquipmentChanges();
    }

}
export class NixieValveCommands extends ValveCommands {
    public async setValveAsync(obj: any): Promise<Valve> {
        try {
            let id = typeof obj.id !== 'undefined' ? parseInt(obj.id, 10) : -1;
            obj.master = 1;
            if (isNaN(id) || id <= 0) id = Math.max(sys.valves.getMaxId(false, 49) + 1, 50);

            if (isNaN(id)) return Promise.reject(new InvalidEquipmentIdError(`Nixie: Valve Id has not been defined ${id}`, obj.id, 'Valve'));
            // Check the Nixie Control Panel to make sure the valve exist there.  If it needs to be added then we should add it.
            let valve = sys.valves.getItemById(id, true);
            // Set all the valve properies.
            let vstate = state.valves.getItemById(valve.id, true);
            valve.isActive = true;
            valve.circuit = typeof obj.circuit !== 'undefined' ? obj.circuit : valve.circuit;
            valve.name = typeof obj.name !== 'undefined' ? obj.name : valve.name;
            valve.connectionId = typeof obj.connectionId ? obj.connectionId : valve.connectionId;
            valve.deviceBinding = typeof obj.deviceBinding !== 'undefined' ? obj.deviceBinding : valve.deviceBinding;
            valve.pinId = typeof obj.pinId !== 'undefined' ? obj.pinId : valve.pinId;
            await ncp.valves.setValveAsync(valve, obj);
            sys.board.processStatusAsync();
            return valve;
        } catch (err) { logger.error(`Nixie: Error setting valve definition. ${err.message}`); return Promise.reject(err); }
    }
    public async deleteValveAsync(obj: any): Promise<Valve> {
        try {
            let id = parseInt(obj.id, 10);
            // The following code will make sure we do not encroach on any valves defined by the OCP.
            if (isNaN(id)) return Promise.reject(new InvalidEquipmentIdError('Valve Id has not been defined', obj.id, 'Valve'));
            let valve = sys.valves.getItemById(id, false);
            let vstate = state.valves.getItemById(id);
            valve.isActive = false;
            vstate.hasChanged = true;
            vstate.emitEquipmentChange();
            sys.valves.removeItemById(id);
            state.valves.removeItemById(id);
            ncp.valves.removeById(id);
            return valve;
        } catch (err) { logger.error(`Nixie: Error removing valve from system ${obj.id}: ${err.message}`); return Promise.reject(new Error(`Nixie: Error removing valve from system ${ obj.id }: ${ err.message }`)); }
    }
    public async setValveStateAsync(valve: Valve, vstate: ValveState, isDiverted: boolean) {
        try {
            vstate.name = valve.name;
            await ncp.valves.setValveStateAsync(vstate, isDiverted);
        } catch (err) { logger.error(`Nixie: Error setting valve ${vstate.id}-${vstate.name} state to ${isDiverted}: ${err}`); return Promise.reject(err); }
    }
}
export class NixieHeaterCommands extends HeaterCommands {
    public async setHeaterAsync(obj: any): Promise<Heater> {
        try {
            let id = typeof obj.id === 'undefined' ? -1 : parseInt(obj.id, 10);
            if (isNaN(id)) return Promise.reject(new InvalidEquipmentIdError('Heater Id is not valid.', obj.id, 'Heater'));
            else if (id < 256 && id > 0) return Promise.reject(new InvalidEquipmentIdError('Virtual Heaters controlled by njspc must have an Id > 256.', obj.id, 'Heater'));
            let heater: Heater;
            if (id <= 0) {
                // We are adding a heater.  In this case all heaters are virtual.
                let vheaters = sys.heaters.filter(h => h.isVirtual === true);
                id = vheaters.length + 256;
            }
            heater = sys.heaters.getItemById(id, true);
            if (typeof obj !== undefined) {
                for (var s in obj) {
                    if (s === 'id') continue;
                    heater[s] = obj[s];
                }
            }
            let hstate = state.heaters.getItemById(id, true);
            hstate.isVirtual = heater.isVirtual = true;
            hstate.name = heater.name;
            hstate.type = heater.type;
            heater.master = 1;
            await ncp.heaters.setHeaterAsync(heater, obj);
            await sys.board.heaters.updateHeaterServices();
            return heater;
        } catch (err) { return Promise.reject(new Error(`Error setting heater configuration: ${err}`)); }
    }
    public async deleteHeaterAsync(obj: any): Promise<Heater> {
        return new Promise<Heater>((resolve, reject) => {
            let id = parseInt(obj.id, 10);
            if (isNaN(id)) return reject(new InvalidEquipmentIdError('Cannot delete.  Heater Id is not valid.', obj.id, 'Heater'));
            let heater = sys.heaters.getItemById(id);
            heater.isActive = false;
            sys.heaters.removeItemById(id);
            state.heaters.removeItemById(id);
            sys.board.heaters.updateHeaterServices();
            resolve(heater);
        });
    }
}
export class NixieChemControllerCommands extends ChemControllerCommands {
    protected async setIntelliChemAsync(data: any): Promise<ChemController> {
        try {
            let chem = await super.setIntelliChemAsync(data);
            // Now Nixie needs to make sure we are polling IntelliChem
            return Promise.resolve(chem);
        }
        catch (err) { return Promise.reject(err); }
    }
    protected async setIntelliChemStateAsync(data: any): Promise<ChemControllerState> {
        try {
            let schem = await super.setIntelliChemStateAsync(data);
            return Promise.resolve(schem);
        }
        catch (err) { return Promise.reject(err); }
    }
}
