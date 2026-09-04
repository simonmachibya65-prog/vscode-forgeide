import * as vscode from 'vscode';
import { Spec, SpecsEngine } from './specsEngine';

type Node = SpecNode | TaskNode | InfoNode;

class SpecNode { constructor(public spec: Spec) {} }
class TaskNode { constructor(public spec: Spec, public taskId: string) {} }
class InfoNode  { constructor(public label: string) {} }

export class SpecsTreeProvider implements vscode.TreeDataProvider<Node> {
    private emitter = new vscode.EventEmitter<Node | undefined>();
    onDidChangeTreeData = this.emitter.event;

    constructor(private specsEngine: SpecsEngine) {}

    refresh() { this.emitter.fire(undefined); }

    getTreeItem(element: Node): vscode.TreeItem {
        if (element instanceof SpecNode) {
            const s = element.spec;
            const hasTasks = !!s.tasks?.length;
            const item = new vscode.TreeItem(
                s.title || s.prompt,
                hasTasks
                    ? vscode.TreeItemCollapsibleState.Collapsed
                    : vscode.TreeItemCollapsibleState.None
            );

            // Phase pill summary — mirrors Gatework sidebar pills
            const reqLabel  = s.requirementsApproved ? '✓ Req'  : '○ Req';
            const desLabel  = s.designApproved       ? '✓ Des'  : '○ Des';
            const taskLabel = s.tasksApproved        ? '✓ Tasks': '○ Tasks';
            item.description = `${reqLabel}  ${desLabel}  ${taskLabel}`;

            item.iconPath = new vscode.ThemeIcon(iconForStage(s));
            item.contextValue = `forgeide.spec.${s.stage}`;

            // Click opens the Gatework webview panel for this spec
            item.command = {
                command: 'forgeide.openSpecWebview',
                title: 'Open Spec Panel',
                arguments: [s.id]
            };
            return item;
        }

        if (element instanceof TaskNode) {
            const task = element.spec.tasks?.find(t => t.id === element.taskId);
            const item = new vscode.TreeItem(task?.title ?? element.taskId);
            item.description = task?.status;
            item.iconPath = new vscode.ThemeIcon(
                task?.status === 'done'        ? 'pass-filled'    :
                task?.status === 'in_progress' ? 'sync~spin'      : 'circle-outline'
            );
            item.contextValue = 'forgeide.task';
            // Only allow implementation if tasks phase is approved
            if (element.spec.tasksApproved && task?.status !== 'done') {
                item.command = {
                    command: 'forgeide.implementTask',
                    title: 'Implement Task',
                    arguments: [element.spec.id, element.taskId]
                };
            }
            return item;
        }

        return new vscode.TreeItem((element as InfoNode).label);
    }

    async getChildren(element?: Node): Promise<Node[]> {
        if (!element) {
            const specs = await this.specsEngine.listAll();
            if (!specs.length) {
                return [new InfoNode('No specs yet — run "ForgeIDE: New Spec from Prompt"')];
            }
            return specs.map(s => new SpecNode(s));
        }
        if (element instanceof SpecNode) {
            return (element.spec.tasks ?? []).map(t => new TaskNode(element.spec, t.id));
        }
        return [];
    }
}

function iconForStage(spec: Spec): string {
    if (!spec.requirementsApproved) return 'edit';
    if (!spec.designApproved)       return 'symbol-structure';
    if (!spec.tasksApproved)        return 'checklist';
    if (spec.stage === 'implementing') return 'sync';
    if (spec.stage === 'done')      return 'pass-filled';
    return 'check-all';
}
