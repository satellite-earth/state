const Torrent = require('@satellite-earth/torrent');
const Parcel = require('@satellite-earth/parcel');


const clone = (obj) => {

	if (typeof obj === 'undefined') {
		return undefined;
	}

	return JSON.parse(JSON.stringify(obj));
};

class State extends Torrent {

	constructor (payload, extras = {}) {

		super(payload);

		if (typeof this._signed_.name === 'undefined' || this._signed_.name.length === 0) {
			throw Error('Must provide state \'name\' in signed data. See docs:');
		}

		if (typeof this._signed_.established === 'undefined') {
			throw Error('Must provide block number \'established\' in signed data. See docs:');
		}

		if (typeof this._signed_.updated === 'undefined') {
			this._signed_.updated = this._signed_.established;
		}

		// Object holding the state's data
		this.store = null;

		// Getter and setter logic
		this.nucleus = {};

		// Record of signals that have updated
		// the state in the current epoch
		this.record = {};

		// Event handlers for getter and setter
		this.event = extras.event || {};
	}

	// Inflate from compressed data
	data (data, options = {}) {

		return new Promise((resolve, reject) => {

			// Unpack the data and parse
			const parcel = new Parcel(data);
			const { store, nucleus } = parcel.unpacked;

			// Save store
			this.store = store;

			// Allow caller to override state's nucleus—
			// if nucleus is not supplied, use eval to
			// parse the internally defined functions.
			if (options.nucleus) {
				this.nucleus = options.nucleus;
			} else {

				for (let fn of Object.keys(nucleus)) {
					if (typeof nucleus[fn] !== 'undefined') {
						this.nucleus[fn] = eval(nucleus[fn]);
					}
				}
			}

			// Retorrentify the data
			return super.data(data).then(() => {
				resolve(this);
			}).catch(err => {
				reject(err);
			});
		});
	}

	// Recompute data params for present state
	build () {
		return super.data(Buffer.from(this.compressed));
	}

	// Returns state's store updated with given params
	exec (set, signal, epoch, options = {}) {

		// Use the supplied signal to modify the state's store.
		// Optionally, create a copy of the state before making
		// any changes (when options.safe = true, if any errors
		// are encountered while executing the update logic the
		// the whole operation fails and the updated version is
		// simply discarded instead of leaving partial changes)
		// Otherwise, set logic must preclude this possibility.
		return set(options.safe ? clone(this.store) : this.store, signal, epoch, {

			// Pass in provided event handlers
			event: (name, data) => {
				if (this.events[name]) {
					this.events[name](data);
				}
			},

			// Pass in provided utility libraries
			lib: this.nucleus.lib
		});
	}

	// Update the data store with a signal. There is one special
	// type of signal 'evolve' which allows the world signer to
	// redefine the way that other signals are interpreted.
	set (signal, epoch, options = {}) {

		// Ignore duplicate signals
		if (typeof this.record[signal.uuid] !== 'undefined') {
			return;
		}

		let updated;
		
		// If the signal is modifying this state's nucleus
		if (signal.action === 'evolve' && signal._signed_.evolve) {

			// Parse the object with stringified setter functions
			// and get the new function for this state, if any
			const nucleus = JSON.parse(signal._signed_.evolve)[this.name];

			if (typeof nucleus !== 'undefined') { // If new setter logic provided for this state

				// If lib functions were provided
				if (typeof nucleus.lib !== 'undefined') {

					// Parse and check valid function
					const lib = eval(nucleus.lib);

					if (typeof lib !== 'function') {
						throw Error('Provided \'lib\' logic does not eval to a function');
					}

					// Save new function
					this.nucleus.lib = lib;
				};

				// If new getter logic was provided
				if (typeof nucleus.get !== 'undefined') {

					// Parse and check valid function
					const get = eval(nucleus.get);

					if (typeof get !== 'function') {
						throw Error('Provided \'get\' logic does not eval to a function');
					}

					// Save new function
					this.nucleus.get = get;
				}

				// If new setter logic was provided
				if (typeof nucleus.set !== 'undefined') {

					// Parse and check valid function
					const set = eval(nucleus.set);

					if (typeof set !== 'function') {
						throw Error('Provided \'set\' logic does not eval to a function');
					}

					// Give the new nucleus a chance to (re)initialize the store
					updated = this.exec(set, signal, epoch);

					// Save new function
					this.nucleus.set = set;
				};
			}

		} else { // Signal is just updating ordinary state

			// State updates itself with signal payload
			updated = this.exec(this.nucleus.set, signal, epoch, options);
		}

		// Throw an error if the store is undefined. This could
		// be caused by a signal changing the value of the store
		// store to undefined, or by not initializing the store.
		if (typeof updated === 'undefined') {
			throw Error(`State '${this.name}' store cannot be undefined. See docs:`);
		}

		// Replace the store with the modified version
		this.store = updated;

		// Record block number at which this signal modified state
		this.record[signal.uuid] = signal.blockNumber;

		// Record latest block number at which state was modified
		this._signed_.updated = String(signal.blockNumber);
	}

	// Call getter on store with provided params. If 'safe' option is true,
	// clone the store first and then check for equality afterward to prevent
	// unintentional modification of store data. Cloning comes with a hit to
	// performance (depending on the size of the store) so 'safe' is disabled
	// by default. It is assumed that the get function will be implemented
	// such that it avoids mutating the store in the course of execution.
	get (name, params, options = {}) {

		// Throw error if getter is undefined
		if (typeof this.nucleus.get !== 'function') {
			throw Error(`State '${this.name}' does not have a valid getter function. See docs:`);
		}

		// Optionally copy store for comparison
		let cloned;
		if (options.safe) {
			cloned = clone(this.store);
		}

		// Invoke getter function
		const value = this.nucleus.get(this.store, name, params, {
			lib: this.nucleus.lib
		});
		
		// Optionally verify that call did not mutate store
		if (options.safe && cloned !== JSON.stringify(this.store)) {

			// Restore unmodified copy
			this.store = cloned;

			// Throw error to help with debugging
			throw Error('Illegal mutation of store during get operation');
		}

		return value;
	}

	// Attach an event handler
	on (event, handler) {
		
		if (typeof event === 'undefined') {
			Error('Expected event name as first argument');
		}

		if (typeof handler !== 'function') {
			Error('Expected a function as second argument');
		}

		// Save event handler
		this.events[event] = handler;
	}

	get established () {
		return parseInt(this._signed_.established);
	}

	get updated () {
		return parseInt(this._signed_.updated);
	}

	// Return compressed state
	get compressed () {
		
		if (!this.initialized) {
			return;
		}

		const nucleus = {};

		for (let fn of Object.keys(this.nucleus).sort()) {
			if (typeof this.nucleus[fn] !== 'undefined') {
				nucleus[fn] = String(this.nucleus[fn]);
			}
		}

		// Pack code and data into compressed format
		const parcel = new Parcel({ store: this.store, nucleus });

		return parcel.packed;
	}

	get initialized () {
		return this.store !== null;
	};
}

module.exports = State;
