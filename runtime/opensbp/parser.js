/*
 * runtime/opensbp/parser.js
 * 
 * This is the wrapper module for the OpenSBP parser.
 * Largely, parsing is one by sbp_parser.js which is generated by peg.js from sbp_parser.pegjs
 *
 * This module wraps the parsing functions with convenience methods and objects and provides some additional
 * parsing functionality (sanitizing inputs, optimized parsing for certain commands, working with streams, etc)
 */
var stream = require('stream');
var util = require('util');

var sbp_parser = require('./sbp_parser')
var log = require('../../log').logger('sbp');
var CMD_SPACE_RE = /(\w\w)([ \t]+)([^\s\t,].*)/i
var CMD_RE = /^\s*(\w\w)(((\s*,\s*)([+-]?[0-9]+(\.[0-9]+)?)?)+)\s*$/i
var STUPID_STRING_RE = /(\&[A-Za-z]\w*)\s*=([^\n]*)/i

// Parse the provided statement
// Return the parsed statement
// fastParse attempts to use string slicing and regular expressions to parse the simpler mnemonic commands
// if fastParse can't figure it out (command contains complex expressions or is not of the right type) 
// it will return null.  Since the majority of all OpenSBP commands are simple ones, this function will
// usually work, and will save a bunch of time over using the pegjs parser for everything.
//   statement - The string statement to parse
fastParse = function(statement) {
    var match = statement.match(CMD_RE);
    if(match) {
        // 2 character mnemonic commands (IF is an exception)
        if(match[1] === 'IF') {
            return null
        }
        // Return value, which we'll fill in with arguments
        var retval = {
            type : 'cmd',
            cmd : match[1],
            args : []
        }
        // Parse the arguments, build a list as we go
        var args = match[2].split(',');
        var pargs = args.slice(1);
        for(var i=0; i<pargs.length; i++) {
            var arg = pargs[i]
            if(arg.trim() === '') {
                retval.args.push(undefined);
            } else {
                // TODO not sure we actually need to do this - numbers get parsed out later also
                var n = Number(arg);
                retval.args.push(isNaN(n) ? arg : n);
            }
        }
        // Return the return value
        return retval;
    }

    var match = statement.match(CMD_SPACE_RE);
    if(match) {
        if(match[1] != 'IF') {
            statement = statement.replace(CMD_SPACE_RE, function(match, cmd, space, rest, offset, string) {
                return cmd + ',' + rest;
            });
        }
    }
    return null;
}

// Parse the provided line
// Returns an object representing the parsed statement
// Tries to fast parse first, falls back on the more thorough pegjs parser
parseLine = function(line) {
    line = line.replace(/\r/g,'');

    // Extract end-of-line comments
    parts = line.split("'");
    statement = parts[0]
    comment = parts.slice(1,parts.length)

    try {
        // Use parse optimization
        var obj = fastParse(statement)
        // But fall back on PegJS
        if(!obj) {
            obj = sbp_parser.parse(statement);
        }
    } catch(e) {
        // Parse failure could be because of a stupid unquoted string:
        // eg: &mystring = Hey this is a string, no big deal.
        // If this is a case, actually allow it like an insane person:
        var match = statement.match(STUPID_STRING_RE)
        if(match) {
            obj = {type:"assign",var:match[1], expr:match[2]}
        } else {
            throw e // Or if not, throw the exception like we should do anyway
        }
    }
    
    // Deal with full-line comments
    if(Array.isArray(obj) || obj === null) {
        obj = {"type":"comment", "comment":comment};
    } else {
        if(comment != '') {obj.comment = comment}
    }
    if(obj.type == 'cmd') {
        obj.cmd = obj.cmd.toUpperCase();
    }

    return obj
}

// Parse a string or array of strings
// Returns a list of parsed statements
//   data - The string or array input to parse
parse = function(data) {
    output = []
    
    // Parse from a string or an array of strings
    if(Array.isArray(data)) {
        lines = data;
    } else {
        lines = data.split('\n');
    }

    // Iterate over lines and parse one by one.  Throw an error if any don't parse.
    for(i=0; i<lines.length; i++) {
        try {            
            output.push(parseLine(lines[i]))
        } catch(err) {
            if(err.name == 'SyntaxError') {
                log.error("Syntax Error on line " + (i+1))
                log.error("Expected " + JSON.stringify(err.expected) + " but found " + err.found)
                err.line = i+1;
                log.error(err.line)
            } else {
                log.error(err);
            }
            throw err
        }
    }
    return output
}

// Constructor for Parser object
// Parser is a transform stream that accepts string input and streams out parsed statement objects
function Parser(options) {
    var options = options || {};
    options.objectMode = true;

  // allow use without new
  if (!(this instanceof Parser)) {
    return new Parser(options);
  }
  this.scrap = ""
  // init Transform
  stream.Transform.call(this, options);
}
util.inherits(Parser, stream.Transform);

// Transform function, processes chunks of string data coming in, pushing parsed objects to the output
Parser.prototype._transform = function(chunk, enc, cb) {
    var str = this.scrap + chunk.toString()
    this.pause();
    try {  
      var start = 0;
      for(var i=0; i<str.length; i++) {
            if(str[i] === '\n') {
                var substr = str.substring(start, i)
                this.push(parseLine(substr));
                start = i+1;
            }
        }
        this.scrap = str.substring(start)
    } catch(e) {
        log.error(e)
    }
    this.resume();
    cb();

}

// Handle a stream flush
Parser.prototype._flush = function(done) {
  if (this.scrap) { this.push(parseLine(this.scrap)); }
  this.scrap = '';
  done();
};

// Parse data from the provided stream
// Return a stream whose output is a stream of parsed statements
//         s - The input stream
//   options - parser options
parseStream = function(s, options) {
    var parser = new Parser(options);
    return s.pipe(parser)
}

// Parse the specified file
//   filename - Full path of file to be parsed
//   callback - Called with parsed data, or with error if error
parseFile = function(filename, callback) {
    var st = fs.createReadStream(filename);
    var obj = []
        return parseStream(st)
            .on('data', function(data) {
                obj.push(data)
            })
            .on('end', function() {
                callback(null, obj);
        })
        .on('error', function(err) {
        callback(err);
        });
}

// Below here are some functions for testing the parser functions
// --------------------------------------------------------------

var main = function(){
    var argv = require('minimist')(process.argv);
    var fs = require('fs');
    var filename = argv['_'][2]

    if(filename) {
        log.tick();
        fs.readFile(filename, 'utf8', function(err, data) {
            if(err) {
                return console.log(err);
            } 
            
            var obj = parse(data);
            log.tock('parse');
        });
    } else {
        console.log("Usage: node parser.js filename.sbp");
    }
}

var main2 = function() {
    var argv = require('minimist')(process.argv);
    var fs = require('fs');
    var filename = argv['_'][2]
    if(filename) {
        log.tick();
        var fileStream = fs.createReadStream(filename);
        var obj = []
        parseStream(fileStream)
            .on('data', function(data) {
                obj.push(data)
            })
            .on('end', function() {
        console.log(obj.length + ' lines processed.')
        log.tock("parse");
            });
    }
}

if (require.main === module) {
//    main();
    main2();
}

exports.parse = parse
exports.parseFile = parseFile
exports.parseStream = parseStream
