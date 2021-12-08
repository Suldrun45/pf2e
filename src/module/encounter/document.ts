import { CharacterPF2e, NPCPF2e } from "@actor";
import { CharacterSheetPF2e } from "@actor/character/sheet";
import { RollInitiativeOptionsPF2e } from "@actor/data";
import { SKILL_DICTIONARY } from "@actor/data/values";
import { UserPF2e } from "@module/user";
import { LocalizePF2e } from "@system/localize";
import { CombatantPF2e, RolledCombatant } from "./combatant";

export class EncounterPF2e extends Combat<CombatantPF2e> {
    get active(): boolean {
        return this.data.active;
    }

    /** Sort combatants by initiative rolls, falling back to tiebreak priority and then finally combatant ID (random) */
    protected override _sortCombatants(a: Embedded<CombatantPF2e>, b: Embedded<CombatantPF2e>): number {
        const resolveTie = (): number => {
            const [priorityA, priorityB] = [a, b].map(
                (combatant): number =>
                    combatant.overridePriority(combatant.initiative ?? 0) ??
                    (combatant.actor && "initiative" in combatant.actor.data.data.attributes
                        ? combatant.actor.data.data.attributes.initiative.tiebreakPriority
                        : 3)
            );
            return priorityA === priorityB ? a.id.localeCompare(b.id) : priorityA - priorityB;
        };
        return typeof a.initiative === "number" && typeof b.initiative === "number" && a.initiative === b.initiative
            ? resolveTie()
            : super._sortCombatants(a, b);
    }

    /** A public method to access _sortCombatants in order to get the combatant with the higher initiative */
    getCombatantWithHigherInit(a: RolledCombatant, b: RolledCombatant): RolledCombatant | null {
        const sortResult = this._sortCombatants(a, b);
        return sortResult > 0 ? b : sortResult < 0 ? a : null;
    }

    /** Exclude orphaned, loot-actor, and minion tokens from combat */
    override async createEmbeddedDocuments(
        embeddedName: "Combatant",
        data: PreCreate<foundry.data.CombatantSource>[],
        context: DocumentModificationContext = {}
    ): Promise<Embedded<CombatantPF2e>[]> {
        const createData = data.filter((datum) => {
            const token = canvas.tokens.placeables.find((canvasToken) => canvasToken.id === datum.tokenId);
            if (!token) return false;

            const { actor } = token;
            if (!actor) {
                ui.notifications.warn(`${token.name} has no associated actor.`);
                return false;
            }
            if (actor.type === "loot" || actor.traits.has("minion")) {
                const translation = LocalizePF2e.translations.PF2E.Encounter.ExcludingFromInitiative;
                const type = game.i18n.localize(
                    actor.traits.has("minion")
                        ? CONFIG.PF2E.creatureTraits.minion
                        : CONFIG.PF2E.actorTypes[actor.data.type]
                );
                ui.notifications.info(game.i18n.format(translation, { type, actor: actor.name }));
                return false;
            }
            return true;
        });
        return super.createEmbeddedDocuments(embeddedName, createData, context);
    }

    /** Call hooks for modules on turn change */
    override async nextTurn(): Promise<this> {
        Hooks.call("pf2e.endTurn", this.combatant ?? null, this, game.user.id);
        await super.nextTurn();
        Hooks.call("pf2e.startTurn", this.combatant ?? null, this, game.user.id);
        return this;
    }

    /** Roll initiative for PCs and NPCs using their prepared roll methods */
    override async rollInitiative(ids: string[], options: RollInitiativeOptionsPF2e = {}): Promise<this> {
        const combatants = ids.flatMap((id) => this.combatants.get(id) ?? []);
        const fightyCombatants = combatants.filter(
            (combatant): combatant is Embedded<CombatantPF2e<CharacterPF2e | NPCPF2e>> =>
                combatant.actor instanceof CharacterPF2e || combatant.actor instanceof NPCPF2e
        );
        const rollResults = await Promise.all(
            fightyCombatants.map((combatant) => {
                const checkType = combatant.actor.data.data.attributes.initiative.ability;
                const skills: Record<string, string | undefined> = SKILL_DICTIONARY;
                const rollOptions = combatant.actor.getRollOptions([
                    "all",
                    "initiative",
                    skills[checkType] ?? checkType,
                ]);
                if (options.secret) rollOptions.push("secret");
                return combatant.actor.data.data.attributes.initiative.roll({
                    options: rollOptions,
                    updateTracker: false,
                });
            })
        );

        const initiatives = rollResults.flatMap((result) =>
            result ? { id: result.combatant.id, value: result.roll.total } : []
        );

        this.setMultipleInitiatives(initiatives);

        // Roll the rest with the parent method
        const remainingIds = ids.filter((id) => !fightyCombatants.some((c) => c.id === id));
        return super.rollInitiative(remainingIds, options);
    }

    /** Set the initiative of multiple combatants */
    async setMultipleInitiatives(
        initiatives: { id: string; value: number; overridePriority?: number | null }[]
    ): Promise<void> {
        const currentId = this.combatant?.id;
        const updates = initiatives.map((i) => ({
            _id: i.id,
            initiative: i.value,
            flags: {
                pf2e: {
                    overridePriority: {
                        [i.value]: i.overridePriority,
                    },
                },
            },
        }));
        await this.updateEmbeddedDocuments("Combatant", updates);
        // Ensure the current turn is preserved
        await this.update({ turn: this.turns.findIndex((c) => c.id === currentId) });
    }

    /* -------------------------------------------- */
    /*  Event Listeners and Handlers                */
    /* -------------------------------------------- */

    /** Disable the initiative button on PC sheets if this was the only encounter */
    protected override _onDelete(options: DocumentModificationContext, userId: string): void {
        super._onDelete(options, userId);

        if (this.started) {
            Hooks.call("pf2e.endTurn", this.combatant ?? null, this, userId);
        }

        // Disable the initiative button if this was the only encounter
        if (!game.combat) {
            const pcSheets = Object.values(ui.windows).filter(
                (sheet): sheet is CharacterSheetPF2e => sheet instanceof CharacterSheetPF2e
            );
            for (const sheet of pcSheets) {
                sheet.disableInitiativeButton();
            }
        }
    }

    /** Enable the initiative button on PC sheets */
    protected override _onCreate(
        data: foundry.data.CombatSource,
        options: DocumentModificationContext,
        userId: string
    ): void {
        super._onCreate(data, options, userId);

        const pcSheets = Object.values(ui.windows).filter(
            (sheet): sheet is CharacterSheetPF2e => sheet instanceof CharacterSheetPF2e
        );
        for (const sheet of pcSheets) {
            sheet.enableInitiativeButton();
        }
    }

    /** Call onTurnStart for each rule element on the new turn's actor */
    protected override _onUpdate(
        changed: DeepPartial<foundry.data.CombatSource>,
        options: DocumentModificationContext,
        userId: string
    ): void {
        super._onUpdate(changed, options, userId);

        // No updates necessary if this combatant has already had a turn this round
        if (!this.combatant?.actor || this.combatant.roundOfLastTurn === this.round) return;

        const lastTurn = this.previous.turn;
        const isNextTurn = typeof changed.turn === "number" && (lastTurn === null || changed.turn > lastTurn);
        const { actor } = this.combatant;
        if (!isNextTurn) return;

        // Find the best user to make the update
        const updater = ((): UserPF2e | null => {
            const userUpdatingThis = game.users.get(userId, { strict: true });

            const activeUsers = game.users.filter((u) => u.active);
            const assignedUser = activeUsers.find((u) => u.character === actor);
            const firstGM = activeUsers.find((u) => u.isGM);
            const anyoneWithPermission = activeUsers.find((u) => actor.canUserModify(u, "update"));
            return userUpdatingThis.active && actor.canUserModify(userUpdatingThis, "update")
                ? userUpdatingThis
                : assignedUser ?? firstGM ?? anyoneWithPermission ?? null;
        })();
        if (game.user !== updater) return;

        this.combatant.update({ "flags.pf2e.roundOfLastTurn": this.round }).then(() => {
            // Now that a user has been found, make the updates if there are any
            const actorUpdates: Record<string, unknown> = {};
            for (const rule of actor.rules) {
                rule.onTurnStart?.(actorUpdates);
            }
            if (Object.keys(actorUpdates).length > 0) {
                actor.update(actorUpdates);
            }
        });
    }
}

export interface EncounterPF2e {
    readonly data: foundry.data.CombatData<this, CombatantPF2e>;

    rollNPC(options: RollInitiativeOptionsPF2e): Promise<this>;
}
