import { WorkspaceFolder, TaskProvider, Task, TaskDefinition, ShellExecution, TaskScope } from "vscode";
import * as path from 'path';
import * as fs from 'fs';

/**
 * A task provider for eXist package directories, currently providing a task
 * to automatically sync directory content to a database collection.
 * 
 * The task provider will only return tasks for directories containing a ´.existdb.json`
 * configuration file.
 *
 * @author Wolfgang Meier
 */
export class ExistTaskProvider implements TaskProvider {

	private workspaceFolders: WorkspaceFolder[];
	private syncScript: string;
	private taskPromise: Thenable<Task[]> | undefined = undefined;

	constructor(workspaceFolders: WorkspaceFolder[], syncScript: string) {
		this.workspaceFolders = workspaceFolders;
		this.syncScript = syncScript;
	}

	public provideTasks(): Thenable<Task[]> | undefined {
		if (!this.taskPromise) {
			this.taskPromise = this.getTasks();
		}
		return this.taskPromise;
	}

	public resolveTask(_task: Task): Task | undefined {
		return undefined;
	}

	private async getTasks(): Promise<Task[]> {
		let result: Task[] = [];
		for (let folder of this.workspaceFolders) {
			const config = path.join(folder.uri.fsPath, '.existdb.json');
			if (!fs.existsSync(config)) {
				continue;
			}
			const configData = fs.readFileSync(config, 'utf8');
			const json = JSON.parse(configData);
			const sync = json.sync;
			if (!sync) {
				continue;
			}
			const serverDef = sync.server;
			if (!serverDef) {
				continue;
			}
			const server = json.servers[serverDef];
			if (!server) {
				continue;
			}
			const collection = sync.root || server.root;
			if (!collection) {
				continue;
			}
			const user = sync.user || server.user;
			const password = sync.password || server.password;
			const kind: ExistTaskDefinition = {
				type: 'existdb-sync',
				server: server.server,
				user: user,
				password: password,
				root: collection,
				dir: folder.uri.fsPath,
				ignore: sync.ignore
			};
			let command = `node ${this.syncScript} -s ${server.server} -u ${user} -p ${password}  `;
			command += `-c ${collection} "${folder.uri.fsPath}" -i ${sync.ignore.map(p => `"${p}"`).join(' ')}`;
			const task = new Task(kind, TaskScope.Workspace, `sync-${folder.name}`, 'existdb', new ShellExecution(command));
			result.push(task);
		}
		return result;
	}
}

interface ExistTaskDefinition extends TaskDefinition {
	server: string;
	user: string;
	password: string;
	root: string;
	dir: string;
	ignore: string[];
}

