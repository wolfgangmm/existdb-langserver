import * as yargs from 'yargs';
import * as chokidar from 'chokidar';
import * as fs from 'fs';
import * as path from 'path';
import * as request from 'request';
import * as mime from 'mime';
import chalk from 'chalk';

mime.define({
	'application/xquery': ['xq', 'xql', 'xqm', 'xquery'],
	'application/xml': ['odd']
});

function store(config: any, file: string, relPath: string, add: boolean = false) {
	const url = config.server + "/apps/atom-editor/store" + config.collection + "/" + relPath;
	const contentType = mime.getType(path.extname(file));
	const stat = fs.statSync(file);

	const options = {
		uri: url,
		method: "PUT",
		auth: {
			user: config.user,
			pass: config.password || "",
			sendImmediately: true
		},
		headers: {
			"Content-Type": contentType,
			"Content-Length": stat.size
		}
	};

	console.log(chalk`Uploading {blue ${relPath}} as {magenta ${contentType}}...`);

	const self = this;
	fs.createReadStream(file).pipe(
		request(
			options,
			(error, response, body) => {
				if (error || !(response.statusCode == 200 || response.statusCode == 201)) {
					console.log(chalk`Upload of {red ${relPath}} failed`);
					response.pipe(process.stderr);
				}
				if (contentType === "application/xquery" && add) {
					query(config, "sm:chmod(xs:anyURI('" + config.collection + "/" + relPath + "'), 'rwxr-xr-x')");
				}
			}
		)
	);
}

function remove(config: any, relPath: string) {
	const url = config.server + "/apps/atom-editor/delete" + config.collection + "/" + relPath;
	const options = {
		uri: url,
		method: "GET",
		auth: {
			user: config.user,
			pass: config.password || "",
			sendImmediately: true
		}
	};
	console.log(chalk`Deleting {blue ${relPath}} ...`);
	request(
		options,
		(error, response, body) => {
			if (error || !(response.statusCode == 200 || response.statusCode == 201)) {
				console.error(chalk`Failed to delete {red ${relPath}}`);
				response.pipe(process.stderr);
			}
		}
	);
}

function query(config: any, query: string) {
	const url = config.server + "/apps/atom-editor/run?q=" + encodeURIComponent(query);
	const options = {
		uri: url,
		method: "GET",
		json: true,
		auth: {
			user: config.user,
			pass: config.password || "",
			sendImmediately: true
		}
	};
	request(
		options,
		function (error, response, body) {
			if (error || !(response.statusCode == 200 || response.statusCode == 201)) {
				console.log('Query failed');
				response.pipe(process.stderr);
			}
		}
	);
}

function createCollection(config: any, relPath: string) {
	console.log(chalk`Creating collection {blue ${relPath}} in {magenta ${config.collection}}`);
	query(config, `fold-left(tokenize("${relPath}", "/"), "${config.collection}", function($parent, $component) {
        xmldb:create-collection($parent, $component)
    })`);
}

const argv = yargs.options({
	s: { alias: 'server', type: 'string', default: 'http://localhost:8080/exist' },
	u: { alias: 'user', type: 'string', default: 'admin' },
	p: { alias: 'password', type: 'string', default: '' },
	c: { alias: 'collection', type: 'string', demandOption: true },
	i: { alias: 'ignore', type: 'string', array: true, default: [] }
}).argv;

if (argv._.length == 0) {
	console.log('please specify a directory to watch');
	process.exit(1);
}
const dir = path.resolve(argv._[0]);
if (!fs.existsSync(dir)) {
	console.log(`directory ${argv._[0]} not found`);
	process.exit(1);
}
const stats = fs.statSync(dir);
if (!stats.isDirectory()) {
	console.log(`${argv._[0]} is not a directory`);
	process.exit(1);
}

console.log(chalk`Watching {green ${dir}}`);
const ignored = argv.i.map(p => {
	return path.join(dir, p);
});

const watcher = chokidar.watch(dir, {
	ignored: ignored,
	ignoreInitial: true,
	awaitWriteFinish: true
});
if (watcher.options.useFsEvents) {
	console.log(chalk`{dim Using fs events.}`);
}
watcher.on('change', file => {
	store(argv, file, path.relative(dir, file));
});
watcher.on('add', file => {
	store(argv, file, path.relative(dir, file), true);
});
watcher.on('unlink', file => {
	remove(argv, path.relative(dir, file));
});
watcher.on('unlinkDir', file => {
	remove(argv, path.relative(dir, file));
});
watcher.on('addDir', added => {
	createCollection(argv, path.relative(dir, added));
});