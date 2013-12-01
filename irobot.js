var events = require('events');
var util = require('util');

var _ = require('lodash');
var extend = require('node.extend');
var serialport = require('serialport');

var commands = require('./commands');
var demos = require('./demos');
var misc = require('./misc');
var sensors = require('./sensors');
var songs = require('./songs');

var Robot = function (device, options) {
  events.EventEmitter.call(this);

  if (!_.isString(device)) {
    var err = new Error('a valid serial device string is required!');
    err.invalid_device = device;
    throw err;
  }

  // set up our options. we pull in the device we were given for convenience
  var defaults = {
    device: device,
    baudrate: 57600
  };
  this.options = extend(defaults, options);

  // the parsed contents of the most recent streamed data response, kept around
  // so we can compare subsequent responses for differences.
  this._sensorData = null;

  // initiate a serial connection to the robot
  this.serial = new serialport.SerialPort(this.options.device, {
    baudrate: this.options.baudrate,
    databits: 8,
    stopbits: 1,
    parity: 'none',

    // use our custom packet parser
    parser: this._parseSerialData.bind(this)
  });

  // run our setup function once the serial connection is ready
  this.serial.on('open', this._init.bind(this));

  // handle incoming sensor data whenever we get it
  this.on('sensordata', this._handleSensorData.bind(this));

  // the current state of the power LEDs. all always start at zero, which is
  // what the create puts them at when the mode is changed to safe or full.
  // NOTE: if the create is in passive mode, these values will be wrong, but
  // that case is unlikely so we ignore it.
  this._ledState = {
    play: false,
    advance: false,
    power_intensity: 0,
    power_color: 0
  };

  // where incoming serial data is held until a complete packet is received
  this._buffer = [];
};

util.inherits(Robot, events.EventEmitter);

// run once the serial port reports a connection
Robot.prototype._init = function () {
  // send the required initial start command to the robot
  this._sendCommand(commands.Start);

  // enter safe mode by default
  this.safeMode();

  // start streaming all sensor data. we manually specify the packet ids we need
  // since streaming with the special bytes (id < 7) returns responses that
  // require special cases to correctly parse.
  var packets = _.pluck(sensors.ALL_SENSOR_PACKETS, 'id');
  this._sendCommand(commands.Stream, packets.length, packets);

  // give feedback that we've connected
  this.sing(songs.START);

  // zero the LED values (so we can be sure about what the LED state is), then
  // turn the power LED green with 100% brightness.
  this.setLEDs({
    play: false,
    advance: false,
    power_intensity: 1,
    power_color: 0
  });

  // emit an event to alert that we're now ready to receive commands once we've
  // received the first sensor data. that means that the robot is communicating
  // with us and ready to go!
  this.once('sensordata', _.bind(this.emit, this, 'ready'));

  return this;
};

// collect serial data in an internal buffer until we receive an entire packet,
// and then emit a 'packet' event so that packet can be specifically parsed.
Robot.prototype._parseSerialData = function (emitter, data) {
  // add the received bytes to our internal buffer in-place
  Array.prototype.push.apply(this._buffer, data);

  // attempt to find a valid packet in our stored bytes
  for (var i = this._buffer.length; i >= 0; i--) {
    if (this._buffer[i] === sensors.PACKET_HEADER) {
      // the packet length byte value and the packet end index (exclusive)
      var packetLength = this._buffer[i + 1];
      var endIndex = i + packetLength + 3;

      // set our indexes if we got a valid packet
      var packet = this._buffer.slice(i, endIndex);
      if (sensors.isValidSensorPacket(packet)) {
        // discard all bytes up to the packet's last byte inclusive
        this._buffer.splice(0, endIndex);

        // strip off the header, length, and checksum since we don't need them
        packet = packet.slice(2, -1);

        // parse the sensor data and emit an event with it. if we fail, just
        // alert that we got a bad packet and continue. since there are lots of
        // packets coming through, some are bound to end up corrupted.
        try {
          this.emit('sensordata', sensors.parseSensorData(packet));
        } catch (e) {
          var err = new Error('bad sensor data packet received');
          err.parse_error = e;
          err.packet = packet;
          this.emit('badpacket', err);
        }

        break;
      }
    }
  }

  return this;
};

// handle incoming sensor data and emit events to notify of changes
Robot.prototype._handleSensorData = function (sensorData) {
  // if there was previous sensor data, handle pertinent state changes and emit
  // events as appropriate.
  if (this._sensorData) {
    // TODO: emit events and update state
  }

  // update the stored sensor values now that we're done looking at them
  this._sensorData = sensorData;

  return this;
};

// send a command packet to the robot over the serial port, with additional
// arguments recursively flattened into individual bytes.
Robot.prototype._sendCommand = function (command) {
  // turn the arguments into a packet of command opcode followed by data bytes.
  // arrays in arguments after the first are flattened.
  var packet = _.flatten(Array.prototype.slice.call(arguments, 1));
  packet.unshift(command.opcode);

  var packetBytes = new Buffer(packet);

  console.log(command.name + '[' + command.opcode + ']:', packet.slice(1));

  // write the bytes and flush the write to force sending the data immediately
  this.serial.write(packetBytes);
  this.serial.flush();

  return this;
};

// return a copy of the most recently received sensor data
Robot.getSensorData = function () {
  return extend({}, this._sensorData);
};

// return the most recently received battery information
Robot.prototype.getBatteryInfo = function () {
  return this.getSensorData().battery;
};

// make the robot play a song. notes is an array of arrays, where each item is a
// pair of note frequency in Hertz followed by its duration in milliseconds.
// non-numeric note values (like null) and out-of-range notes are treated as
// pauses.
Robot.prototype.sing = function (notes) {
  if (notes && notes.length > 0) {
    // create a copy of the notes array so we can modify it at-will
    notes = notes.slice();

    // fill all the available song slots with our segments, and store their
    // durations away so we can set timeouts to play them in turn.
    var cumulativeDelay = 0;
    while (notes.length > 0) {
      // convert the next song-length segment and reduce the notes array
      var song = songs.toCreateFormat(notes.splice(0, songs.MAX_SONG_LENGTH));

      // schedule this segment for storage and playback
      setTimeout(_.bind(this._storeAndPlaySong, this, song), cumulativeDelay);

      // calculate the delay from the 64ths of second parts, since it will be
      // more accurate than using the milliseconds, which were lossily converted
      // to 64ths of a second before being stored on the robot. we use ceil so
      // we don't accidentally call our callback before the previous segment is
      // done, which would cause the new requested playback to fail.
      var duration = 0;
      for (var j = song.length - 1; j >= 0; j--) { duration += song[j][1]; }
      cumulativeDelay += Math.ceil(duration * 1000 / 64);
    }
  }

  return this;
};

// store a song in the first song slot, then immediately request its playback
Robot.prototype._storeAndPlaySong = function (notes) {
  var slot = 0;
  this._sendCommand(commands.Song, slot, notes.length, notes);
  this._sendCommand(commands.PlaySong, slot);
};

// put the robot into passive mode
Robot.prototype.passiveMode = function () {
  this._sendCommand(commands.Start);
  return this;
};

// put the robot into safe mode
Robot.prototype.safeMode = function () {
  this._sendCommand(commands.Safe);

  // reset the LEDs so they'll take on the last values that were set
  this.setLEDs();

  return this;
};

// put the robot into full mode
Robot.prototype.fullMode = function () {
  this._sendCommand(commands.Full);
  this.setLEDs();
  return this;
};

// run one of the built-in demos specified by the demo id. to stop the demo,
// use #halt().
Robot.prototype.demo = function (demoId) {
  this._sendCommand(commands.Demo, demoId);
  return this;
};

// tell the robot to seek out and mate with its dock. to cancel the docking
// maneuver, use #halt().
Robot.prototype.dock = function () {
  this.demo(demos.CoverAndDock);
  return this;
};

// toggle the play or advance LED by name. defaults the 'enable' value to the
// inverse of the last set value.
Robot.prototype._toggleLED = function (name, enable) {
  enable = _.isUndefined(enable) ? !this._ledState[name] : enable;

  // create and set an LED state object with our key and boolean value
  var state = {};
  state[name] = !!enable;
  this.setLEDs(state);

  return this;
};

// toggle the state of the 'play' LED, or set it to the value given (true for
// on, false for off).
Robot.prototype.togglePlayLED = function (enable) {
  this._toggleLED('play', enable);
  return this;
};

// toggle the state of the 'advance' LED, or set it to the given value (true for
// on, false for off).
Robot.prototype.toggleAdvanceLED = function (enable) {
  this._toggleLED('advance', enable);
  return this;
};

// set the intensity and color of the power LED. if intensity is not given,
// defaults to 0. if only an intensity is given, the color is left unchanged.
// intensity ranges from 0 (off) to 1 (maximum brightness). color ranges from 0
// (green) to 1 (red) with intermediate values being a blend between these
// colors (orange, yellow, etc.).
Robot.prototype.setPowerLED = function (intensity, color) {
  // default intensity to 0
  intensity = _.isNumber(intensity) ? intensity : 0;

  this.setLEDs({
    power_intensity: intensity,
    power_color: color
  });

  return this;
};

// set the state of all LEDs at once. all parameter values behave as they do in
// their individual methods, with the exception that undefined values are filled
// in from the last set LED state values.
//
// this function, or any of the individual functions, will have no effect if the
// robot is in passive mode. once the mode is changed from passive to safe or
// full, the last set LED state will be restored.
//
// expects an object like:
// {
//   play: true,
//   advance: false,
//   power_color: 0.2,
//   power_intensity: 0.65
// }
Robot.prototype.setLEDs = function (leds) {
  // copy the object we were sent so we can modify its values
  leds = extend({}, leds);

  // turn the play and advance values into bytes of 0 or 1
  if (!_.isUndefined(leds.play)) {
    leds.play = +(!!leds.play);
  }
  if (!_.isUndefined(leds.advance)) {
    leds.advance = +(!!leds.advance);
  }

  // turn the power intensity and color values into bytes between 0 and 255
  if (!_.isUndefined(leds.power_intensity)) {
    leds.power_intensity = Math.round(
        Math.max(0, Math.min(255, 255 * leds.power_intensity)));
  }
  if (!_.isUndefined(leds.power_color)) {
    leds.power_color = Math.round(
        Math.max(0, Math.min(255, 255 * leds.power_color)));
  }

  // fill in missing values from the prior state
  leds = extend({}, this._ledState, leds);

  // send the command to update the LEDs
  this._sendCommand(commands.LEDs,
    // build the play/advance state byte
    misc.bitsToByte([false, leds.play, false, leds.advance]),

    leds.power_color,
    leds.power_intensity
  );

  // store the state for the next time an LED function is called
  this._ledState = leds;

  return this;
};

// drive the robot in one of two ways:
//  - velocity, radius
//  - { right: velocity, left: velocity }
// if radius is left unspecified, 'straight' is assumed. if an individual
// velocity is left unspecified, 0 is assumed.
Robot.prototype.drive = function (velocity, radius) {
  var maxVelocity = 500; // millimeters per second
  var maxRadius = 2000; // millimeters

  // default the radius to 'straight'
  radius = radius || 0;

  // the command we'll eventually run
  var command = null;

  // for transforming our numbers into individual bytes
  var data = new Buffer(4);

  // handle the two different calling conventions
  if (_.isNumber(velocity)) {
    command = commands.Drive;

    // constrain values
    velocity = Math.max(-maxVelocity, Math.min(maxVelocity, velocity));
    radius = Math.max(-maxRadius, Math.min(maxRadius, radius));

    // build the bytes for our velocity numbers
    data.writeInt16BE(velocity, 0);
    data.writeInt16BE(radius, 2);
  } else {
    command = commands.DriveDirect;

    // use direct drive, where each wheel gets its own independent velocity
    var velocityLeft = Math.max(-maxVelocity,
        Math.min(maxVelocity, velocity.left || 0));
    var velocityRight = Math.max(-maxVelocity,
        Math.min(maxVelocity, velocity.right || 0));

    data.writeInt16BE(velocityLeft, 0);
    data.writeInt16BE(velocityRight, 2);
  }

  this._sendCommand(command, data.toJSON());

  return this;
};

// stop the robot from moving/rotating, and stop any current demo
Robot.prototype.halt = function () {
  this.drive(0, 0);
  this.demo(demos.Abort);
  return this;
};

module.exports.Robot = Robot;
