<div align="center">

<img src="assets/summary.svg" width="98%" alt="Contributions sur douze mois, variation sur sept jours, série hebdomadaire et chiffres publics">

<img src="assets/activity.svg" width="48%" alt="Contributions cumulées sur douze mois"> <img src="assets/mix.svg" width="48%" alt="Répartition de l'activité : commits, pull requests, tickets, revues">

<img src="assets/matrix.svg" width="98%" alt="Matrice d'activité : une case par jour sur cinquante-deux semaines">

<img src="assets/iso.svg" width="98%" alt="L'année en relief : une tuile par jour, la hauteur valant les contributions">

<img src="assets/languages.svg" width="48%" alt="Répartition par langage, en octets de code"> <img src="assets/radar.svg" width="48%" alt="Radar des sept jours de la semaine">

<img src="assets/streak.svg" width="48%" alt="Séries de jours consécutifs et trente derniers jours"> <img src="assets/clock.svg" width="48%" alt="Cadran des heures d'activité, heure de Paris">

<img src="assets/punch.svg" width="98%" alt="Carte perforée : jour de la semaine par heure">

<img src="assets/vintage.svg" width="48%" alt="Dépôts publics ouverts par année"> <img src="assets/size.svg" width="48%" alt="Tailles des plus gros dépôts publics, par rang">

</div>

### Silicon Floor

Le terminal des valeurs de l'IA et des semi-conducteurs. Qui détient quoi, qui achète, qui vend : chaque chiffre
reconstruit depuis les dépôts de la SEC, daté et cité. Serveur **MCP** public, 18 outils, sans clé ni inscription.

```
claude mcp add --transport http siliconfloor https://siliconfloor.com/mcp
```

[siliconfloor.com](https://siliconfloor.com) · [Documentation](https://siliconfloor.com/docs/mcp) · [Dépôt](https://github.com/Baptoshi/silicon-floor) · [`npx siliconfloor-mcp`](https://www.npmjs.com/package/siliconfloor-mcp)

---

<sub>
Douze widgets redessinés toutes les deux heures par <a href="scripts/card.mjs">scripts/card.mjs</a>, depuis l'API
GitHub et le flux d'événements publics. Chacun dit la mesure qu'il trace, son unité et sa fenêtre : rien n'est noté,
pondéré ni extrapolé. Les dépôts y sont <strong>publics uniquement</strong> et lus en <strong>agrégat</strong> —
langages, millésimes, tailles, étoiles : ni nom, ni contenu, ni description. Les heures viennent des derniers
événements publics, sur la fenêtre que l'API rend, affichée sur les cadrans.
</sub>
