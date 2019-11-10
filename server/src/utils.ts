import * as request from 'request';
import { ServerSettings } from './settings';
import * as path from 'path';
import * as fs from 'fs';
import { WorkspaceFolder } from 'vscode-languageserver';
import { URI } from 'vscode-uri';

// require('request-debug')(request);

const DEFAULT_CONFIG = {
	servers: {
		"localhost": {
			server: "http://localhost:8080/exist",
			user: "admin",
			password: "",
			root: ""
		}
	},
	sync: {
		server: "localhost",
		ignore: [
			'.existdb.json',
			'.git/**',
			'node_modules/**',
			'bower_components/**',
			'package*.json',
			'.vscode/**'
		]
	}
};

/**
 * Check if the current workspace folder contains a `.existdb.json` file and
 * return a settings object corresponding to it.
 * 
 * @param workspaceFolder the workspace folder to check for a configuration
 */
export function readWorkspaceConfig(workspaceFolder: WorkspaceFolder): ServerSettings | null {
	const uri = URI.parse(workspaceFolder.uri);
	const config = path.join(uri.fsPath, '.existdb.json');
	if (!fs.existsSync(config)) {
		return null;
	}

	const configData = fs.readFileSync(config, 'utf8');
	const json = JSON.parse(configData);
	const sync = json.sync;
	const servers = json.servers;
	if (!servers) {
		// invalid configuration: no server definition
		return null;
	}

	if (sync && sync.server) {
		const server = servers[sync.server];
		if (server) {
			return {
				uri: server.server,
				user: sync.user || server.user,
				password: sync.password || server.password,
				path: sync.root || server.root || "/db"
			};
		}
	}

	const allServers = Object.values(servers);
	if (allServers.length === 0) {
		return null;
	}
	const server: any = allServers[0];
	return {
		uri: server.server,
		user: server.user,
		password: server.password,
		path: server.root || '/db'
	};
}

export function checkServer(workspaceConfig: ServerSettings, resourcesDir: string): Promise<any | null> {
	if (!workspaceConfig) {
		return Promise.resolve(null);
	}
	const xar = getXar(resourcesDir);
	if (!xar) {
		return Promise.reject('Internal error: xar file missing');
	}

	const xquery = `
		xquery version "3.0";

		declare namespace expath="http://expath.org/ns/pkg";
		declare namespace output="http://www.w3.org/2010/xslt-xquery-serialization";
		declare option output:method "json";
		declare option output:media-type "application/json";

		if ("http://exist-db.org/apps/atom-editor" = repo:list()) then
			let $data := repo:get-resource("http://exist-db.org/apps/atom-editor", "expath-pkg.xml")
			let $xml := parse-xml(util:binary-to-string($data))
			return
				if ($xml/expath:package/@version = "${xar.version}") then
					true()
				else
					$xml/expath:package/@version/string()
		else
			false()`;
	return new Promise((resolve, reject) => {
		query(workspaceConfig, xquery).then((body) => {
			let message;
			if (body === true) {
				resolve(null);
			} else if (typeof body === 'string') {
				message = `Installed support app has version ${body}. A newer version (${xar.version}) is recommended for proper operation. Do you want to install it?`;
			} else {
				message = "This package requires a small support app to be installed on the eXistdb server. Do you want to install it?";
			}
			resolve({
				message: message,
				xar: xar
			});
		}).catch(statusCode => {
			reject(`Connection to server failed ${statusCode}`);
		});
	});
}

export async function installXar(settings: ServerSettings | null, xar: any): Promise<Boolean> {
	if (!settings) {
		return true;
	}
	const fileName = path.basename(xar.path);
	const targetPath = `/db/system/repo/${fileName}`;
	const url = `${settings.uri}/rest${targetPath}`;
	const options = {
		uri: url,
		method: "PUT",
		strictSSL: false,
		headers: {
			"Content-Type": "application/octet-stream"
		},
		auth: {
			user: settings.user,
			pass: settings.password,
			sendImmediately: true
		}
	};
	return new Promise((resolve, reject) => {
		fs.createReadStream(xar.path).pipe(
			request(
				options,
				function (error, response) {
					if (error || response.statusCode !== 201) {
						reject(error);
					}
					const xquery = `
						xquery version "3.1";

						declare namespace expath="http://expath.org/ns/pkg";
						declare namespace output="http://www.w3.org/2010/xslt-xquery-serialization";
						declare option output:method "json";
						declare option output:media-type "application/json";

						declare variable $repo := "http://demo.exist-db.org/exist/apps/public-repo/modules/find.xql";

						declare function local:remove($package-url as xs:string) as xs:boolean {
							if ($package-url = repo:list()) then
								let $undeploy := repo:undeploy($package-url)
								let $remove := repo:remove($package-url)
								return
									$remove
							else
								false()
						};

						let $xarPath := "${targetPath}"
						let $meta :=
							try {
								compression:unzip(
									util:binary-doc($xarPath),
									function($path as xs:anyURI, $type as xs:string,
										$param as item()*) as xs:boolean {
										$path = "expath-pkg.xml"
									},
									(),
									function($path as xs:anyURI, $type as xs:string, $data as item()?,
										$param as item()*) {
										$data
									}, ()
								)
							} catch * {
								error(xs:QName("local:xar-unpack-error"), "Failed to unpack archive")
							}
						let $package := $meta//expath:package/string(@name)
						let $removed := local:remove($package)
						let $installed := repo:install-and-deploy-from-db($xarPath, $repo)
						return
							repo:get-root()
					`;
					query(settings, xquery).then(resolve).catch(reject);
				}
			)
		);
	});
}

function query(workspaceConfig: ServerSettings | null, query: string): Promise<any> {
	if (!workspaceConfig) {
		return Promise.reject();
	}
	const url = `${workspaceConfig.uri}/rest/db?_query=${encodeURIComponent(query)}&_wrap=no`;
	const options = {
		uri: url,
		method: "GET",
		json: true,
		auth: {
			user: workspaceConfig.user,
			pass: workspaceConfig.password,
			sendImmediately: true
		}
	};
	return new Promise((resolve, reject) => {
		request(
			options,
			function (error, response, body) {
				if (error || !(response.statusCode == 200 || response.statusCode == 201)) {
					reject(error);
				} else {
					resolve(body);
				}
			}
		);
	});
}

function getXar(resourcesDir: string): { version: string; path: string; } | null {
	const files = fs.readdirSync(resourcesDir);
	for (let file of files) {
		if (file.endsWith('.xar')) {
			return {
				version: file.replace(/^.*-([\d\.]+)\.xar/, "$1"),
				path: path.join(resourcesDir, file)
			};
		}
	}
	return null;
}

export function createWorkspaceConfig(workspaceFolder: WorkspaceFolder) {
	const uri = URI.parse(workspaceFolder.uri);
	const config = path.join(uri.fsPath, '.existdb.json');
	if (fs.existsSync(config)) {
		return Promise.resolve(config);
	}
	return new Promise((resolve, reject) => {
		fs.writeFile(config, JSON.stringify(DEFAULT_CONFIG, null, 4), (err) => {
			if (err) {
				reject(err);
				return;
			}
			resolve(config);
		});
	})
}