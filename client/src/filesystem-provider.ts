import * as vscode from 'vscode';
import Axios, { AxiosBasicCredentials } from 'axios';
import * as qs from "querystring";
import * as mime from 'mime';

mime.define({
	'application/xquery': ['xq', 'xql', 'xqm', 'xquery', 'xqs'],
	'application/xml': ['odd', 'xconf']
});

class ServerConfig {
	url: string;
	auth: AxiosBasicCredentials;
};

export class eXistFS implements vscode.FileSystemProvider {

	private _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();

	readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this._emitter.event;

	constructor() {
		console.log('Initializing eXistFS');
	}

	watch(uri: vscode.Uri, options: { recursive: boolean; excludes: string[]; }): vscode.Disposable {
		return new vscode.Disposable(() => {});
	}

	stat(uri: vscode.Uri): vscode.FileStat | Thenable<vscode.FileStat> {
		const config = getServerConfig(uri, 'stat');
		console.log(`eXistFS stat: ${config.url}`);
		return new Promise((resolve, reject) => {
			Axios.request({
				url: config.url,
				method: "GET",
				responseType: 'json',
				auth: config.auth
			}).then((response) => {
				const stat:vscode.FileStat = {
					type: response.data.type === 'collection' ? vscode.FileType.Directory : vscode.FileType.File,
					ctime: new Date(response.data.ctime).getTime(),
					mtime: 0,
					size: 0
				};
				resolve(stat);
			}).catch((error) => {
				console.log('eXistFS error: %s', error.response.status);
				reject();
			});
		});
	}

	readDirectory(uri: vscode.Uri): [string, vscode.FileType][] | Thenable<[string, vscode.FileType][]> {
		const config = getServerConfig(uri, 'collections');
		console.log(`readDirectory: ${config.url}`);
		return new Promise((resolve, reject) => {
			Axios.request({
				url: config.url.toString(),
				method: "GET",
				responseType: 'json',
				auth: config.auth
			}).then((response) => {
				const resources:[string, vscode.FileType][] = response.data.map((item) => {
					return [item.name, item.type === 'collection' ? vscode.FileType.Directory : vscode.FileType.File];
				});
				resolve(resources);
			}).catch((error) => {
				console.log('error: %o', error.response.status);
				resolve(null);
			});
		})
	}

	createDirectory(uri: vscode.Uri): void | Thenable<void> {
		const config = getServerConfig(uri, 'collections');
		console.log(`createDirectory: ${config.url}`);
		return new Promise((resolve, reject) => {
			Axios.request({
				url: config.url,
				method: 'POST',
				responseType: 'json',
				auth: config.auth
			}).then((response) => {
				resolve();
			}).catch((error) => {
				console.log('error: %s %s', error.response.status, error.response.body);
				resolve();
			});
		});
	}

	readFile(uri: vscode.Uri): Uint8Array | Thenable<Uint8Array> {
		const config = getServerConfig(uri, 'files');
		console.log(`stat: ${config.url}`);
		return new Promise((resolve, reject) => {
			Axios.request({
				url: config.url.toString(),
				method: "GET",
				responseType: 'arraybuffer',
				auth: config.auth
			}).then((response) => {
				resolve(new Uint8Array(response.data));
			}).catch((error) => {
				console.log('error: %o', error.response.status);
				resolve(null);
			});
		});
	}

	writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean; }): void | Thenable<void> {
		const config = getServerConfig(uri, 'files');
		console.log(`write: ${config.url}`);
		return new Promise((resolve, reject) => {
			Axios.request({
				url: config.url.toString(),
				method: 'POST',
				data: content,
				responseType: 'json',
				headers: {
					'content-type': 'application/octet-stream'
				},
				auth: config.auth
			}).then((response) => {
				resolve();
			}).catch((error) => {
				console.log('error: %s %s', error.response.status, error.response.body);
				resolve();
			});
		});
	}

	delete(uri: vscode.Uri, options: { recursive: boolean; }): void | Thenable<void> {
		const config = getServerConfig(uri);
		return new Promise((resolve, reject) => {
			Axios.request({
				url: config.url.toString(),
				method: 'DELETE',
				responseType: 'json',
				auth: config.auth
			}).then((response) => {
				resolve();
			}).catch((error) => {
				console.log('error: %s %s', error.response.status, error.response.body);
				reject();
			});
		});
	}

	rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean; }): void | Thenable<void> {
		throw new Error('Method not implemented.');
	}
	copy?(source: vscode.Uri, destination: vscode.Uri, options: { overwrite: boolean; }): void | Thenable<void> {
		throw new Error('Method not implemented.');
	}
	
}

function getServerConfig(uri: vscode.Uri, operation?: string): ServerConfig {
	const params = qs.parse(uri.query);
	const base = params.base;
	return {
		url: `${base}/api/${operation || ''}${uri.path}`,
		auth: {
			username: <string>params.user,
			password: <string>params.pass
		}
	};
}