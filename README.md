# Language Server and Client for XQuery/eXistdb

[![Build Status](https://travis-ci.com/wolfgangmm/existdb-langserver.svg?branch=master)](https://travis-ci.com/wolfgangmm/existdb-langserver)

A language server and Visual Studio Code extension for developing XQuery code targeted at eXistdb. The language server currently supports the following capabilities for XQuery:

* linting: shows errors reported by eXistdb and warnings produced by XQLint
* autocomplete for all functions known in the XQuery context of the current file, including imported modules
* document symbols (functions only) for outline view
* hover: shows signatures and description for local, imported and system-wide functions
* goto definition: navigate to definition of function in local or imported module (as long as it is in the same workspace)

The client extension additionally includes XQuery syntax highlighting based on https://github.com/DotJoshJohnson/vscode-xml.

## Workspace Folders

**Important**: Most language server features require that the edited file is associated with a workspace folder, which will be used as the context to resolve XQuery import paths etc. (see configuration section below). In Visual Studio Code, use `File/Add Folder to Workspace` to add workspace folders. For files not associated with a workspace folder, only basic syntax highlighting will be provided.

## Configuration

The language server talks to an eXist instance in order to provide autocompletion, resolve document symbols, definitions etc. There are three places in which those settings can be provided. The language server will check them in this order:

1. a configuration file, `.existdb.json` in the root of the workspace folder
2. the per-workspace settings for the extension
3. the global, per-user settings for the extension in Visual Studio Code

`.existdb.json` is a simple JSON file:

```json
{
    "servers": {
        "localhost": {
            "server": "http://localhost:8080/exist",
            "user": "admin",
            "password": "",
            "root": "/db/apps/my-app"
        }
    }
}
```

The ~servers~ object maps one or more server ids to the corresponding settings. Right now, the language server supports only one server.

| Property | Description                                                      | Default                 |
| -------- | ---------------------------------------------------------------- | ----------------------- |
| server   | URL pointing to the root of eXist on the server                  | "http://localhost:8080" |
| user     | The name of the user to connect with                             | "admin"                 |
| password | Password of the user                                             | empty                   |
| root     | the root collection corresponding to the workspace on the server | "/db"                   |

The extension requires a helper package to be installed on the eXist instance. As soon as you open a file which activates the extension, it will automatically check if the helper package is present. If not, a popup should appear, asking if the helper package should be installed.

## Syncing Directories to the Server

The extension includes a task provider, which automatically registers a sync task for a workspace if the `.existdb.json` configuration defines sync settings. Any change will be immediately uploaded to the corresponding target collection in the database. This means you can work on the files in the file system as you would usually do.

To prevent unintentional syncs, the task *must* be started manually.

### Start via status bar icon

If a workspace configuration was found, you should find two statusbar icons to the bottom right of the window: 

![Statusbar screenshot](resources/statusbar.png)

The first indicates if the database connection is active, the other shows the sync status. It should display 'off' as initial state. Click on the icon to activate sync. This will list all sync tasks available in the current workspace. Select one to start.

### Start via `Run Task`

1. select `Terminal` / `Run Task` from the Visual Studio Code menu
2. find a task named `existdb-sync-name-of-your-workspace` and select it

### Sync configuration

The configuration for the sync feature should be provided in an additional sync property:

```json
{
    "servers": {
        "localhost": {
            "server": "http://localhost:8080/exist",
            "user": "admin",
            "password": "",
            "root": "/db/apps/my-app"    
        }
    },
    "sync": {
        "server": "localhost",
        "dir": ".",
        "polling": false,
        "ignore": [
            ".existdb.json",
            ".git/**",
            "node_modules/**",
            "bower_components/**"
        ]
    }
}
```

| Property | Description                                                           |
| -------- | --------------------------------------------------------------------- |
| server   | the name of the server entry (in the 'servers'  section to connect to |
| ignore   | an array of file path patterns which should not be synced             |
| dir      | subdirectory to be watched (default: '.')                             |
| polling  | by default, the watcher uses file system events to detect changes. This may fail in certain environments. If the option is enable, the watcher will instead periodically poll files for changes. |

## Executing XQueries

An open XQuery file can be sent to the server for evaluation, using either

* the command `existdb.execute` from the command palette
* pressing the keyboard shortcut `ctrl-alt-enter` (`command-option-enter` on a Mac)
* selecting **Execute current XQuery on the server** from the editor title toolbar

The result returned by eXist is displayed in a new column besides the currently open editor. If the XQuery defines serialization to HTML, the results will be shown in a web view. In all other cases, the source code of the result is displayed.

## Building the Extension

* clone the repository and open the directory in Visual Studio Code
* run `npm install`
* switch to the debug panel in the sidebar and choose *Launch Client* from the run configurations

### Packaging

Install `vsce` once by running

```
npm install -g vsce
```

then package the extension into a `.vsix` file with

```
vsce package
```
