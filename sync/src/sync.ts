import { Command } from 'commander';
import * as chokidar from 'chokidar';
import * as fs from 'fs';
import * as path from 'path';
import * as mime from 'mime';
import chalk from 'chalk';
import Axios from 'axios';

mime.define({
	'application/xquery': ['xq', 'xql', 'xqm', 'xquery'],
	'application/xml': ['odd']
});

function store(config: SyncConfig, file: string, relPath: string, add: boolean = false) {
	const url = config.server + "/apps/atom-editor/store" + config.collection + "/" + relPath;
	const contentType = mime.getType(path.extname(file));
	const {size} = fs.statSync(file);

	console.log(`Uploading ${chalk.blue(relPath)} as ${chalk.magenta(contentType)}...`);

	Axios.request({
		url: url,
		method: 'PUT',
		auth: {
			username: config.user,
			password: config.password || ""
		},
		headers: {
			"Content-Type": contentType,
			"Content-Length": size
		},
		data: fs.createReadStream(file),
		responseType: 'json'
	}).then((response) => {
		if (!(response.status == 200 || response.status == 201) || response.data.status === 'error') {
			console.log(`Upload of ${chalk.red(relPath)} failed: ${chalk.red(response.data.message)}`);
			return;
		}
		if (contentType === "application/xquery" && add) {
			query(config, "sm:chmod(xs:anyURI('" + config.collection + "/" + relPath + "'), 'rwxr-xr-x')");
		}
	}).catch((error) => {
		console.log(`Upload of ${chalk.red(relPath)} failed: ${chalk.red(error.code)}`);
	});
}

function remove(config: SyncConfig, relPath: string) {
	const url = config.server + "/apps/atom-editor/delete" + config.collection + "/" + relPath;
	console.log(`Deleting ${chalk.blue(relPath)} ...`);
	Axios.request({
		url: url,
		method: "GET",
		auth: {
			username: config.user,
			password: config.password || ""
		}
	}).then((response) => {
		if (!(response.status == 200 || response.status == 201)) {
			console.error(`Failed to delete ${chalk.red(relPath)}`);
			response.data.pipe(process.stderr);
		}
	}).catch((error) => {
		console.error(`Failed to delete ${chalk.red(relPath)}: ${chalk.red(error.code)}`);
	});
}

function query(config: SyncConfig, query: string) {
	const url = `${config.server}/apps/atom-editor/run`;
	return new Promise((resolve, reject) => {
		Axios.request({
			url: url,
			method: "GET",
			params: {
				q: query
			},
			auth: {
				username: config.user,
				password: config.password || ""
			},
			responseType: 'json'
		}).then((response) => {
			if (!(response.status == 200 || response.status == 201)) {
				console.log('Query failed');
				response.data.pipe(process.stderr);
				reject(false);
			}
			resolve(response.data);
		}).catch((error) => {
			console.error(`Query failed: ${chalk.red(error)}`);
			reject(false);
		});
	});
}

function createCollection(config: SyncConfig, relPath: string) {
	console.log(`Creating collection ${chalk.blue(relPath)} in ${chalk.magenta(config.collection)}`);
	query(config, `fold-left(tokenize("${relPath}", "/"), "${config.collection}", function($parent, $component) {
        xmldb:create-collection($parent, $component)
    })`);
}

function watch(config: SyncConfig, dir: string, ignored: string[]) {
	console.log(`Watching ${chalk.green(dir)}`);
	const options:chokidar.WatchOptions = {
		ignored: ignored,
		ignoreInitial: true,
		awaitWriteFinish: true,
	};
	if (config.poll) {
		options.usePolling = true;
		if (config.interval) {
			options.interval = config.interval;
		}
		console.log(chalk.dim('Using polling.'));
	}
	const watcher = chokidar.watch(dir, options);
	if (watcher.options.useFsEvents) {
		console.log(chalk.dim('Using fs events.'));
	}
	watcher.on('change', file => {
		store(config, file, path.relative(dir, file));
	});
	watcher.on('add', file => {
		store(config, file, path.relative(dir, file), true);
	});
	watcher.on('unlink', file => {
		remove(config, path.relative(dir, file));
	});
	watcher.on('unlinkDir', file => {
		remove(config, path.relative(dir, file));
	});
	watcher.on('addDir', added => {
		createCollection(config, path.relative(dir, added));
	});
	watcher.on('error', error => {
		console.log('ERROR: %s', chalk.red(error));
	});
}

interface SyncConfig {
	server: string;
	user: string;
	password: string;
	collection: string;
	ignore: string[];
	poll: boolean;
	interval?: number;
}

const program = new Command();

program
	.name('existdb-sync')
	.description('File watcher to automatically keep a directory in sync with the corresponding collection in eXist-db')
	.option('-s, --server <url>', 'server URL', 'http://localhost:8080/exist')
	.option('-u, --user <user>', 'user name', 'admin')
	.option('-p, --password <password>', 'password', '')
	.requiredOption('-c, --collection <collection>', 'target collection')
	.option('-i, --ignore <patterns...>', 'ignore patterns', [])
	.option('--poll', 'use polling instead of file system events', false)
	.option('--interval <ms>', 'polling interval in milliseconds')
	.argument('<directory>', 'directory to watch')
	.parse(process.argv);

const options = program.opts();
const args = program.args;

if (args.length === 0) {
	console.log('please specify a directory to watch');
	process.exit(1);
}

const dir = path.resolve(args[0]);
if (!fs.existsSync(dir)) {
	console.log(`directory ${args[0]} not found`);
	process.exit(1);
}
const stats = fs.statSync(dir);
if (!stats.isDirectory()) {
	console.log(`${args[0]} is not a directory`);
	process.exit(1);
}

const config: SyncConfig = {
	server: options.server,
	user: options.user,
	password: options.password,
	collection: options.collection,
	ignore: options.ignore || [],
	poll: options.poll || false,
	interval: options.interval ? parseInt(options.interval, 10) : undefined
};

const ignored = config.ignore.map((p: string) => {
	return path.join(dir, p);
});

query(config, 'system:get-version()')
	.then(() => {
		watch(config, dir, ignored);
	})
	.catch(() => {
		console.error(`${chalk.red('Communication with the server failed')}. Either it is not running or the helper package was not installed. Giving up.`);
	});